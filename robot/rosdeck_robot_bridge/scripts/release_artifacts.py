#!/usr/bin/env python3
"""Build, sign and verify Rosdeck offline deployment bundles.

Subcommands:

  facts         pin every build input (source revisions, tree hashes) and
                write the facts JSON consumed by `make`;
  make          write the release manifest + SBOM into a staged bundle,
                then produce a deterministic tar.gz, a .sha256 sidecar and,
                optionally, a detached GPG signature;
  sign          add a detached GPG signature to an already built archive;
  verify        check an archive end to end: checksum, signature (when a
                .asc is present) and the embedded bundle manifest;
  verify-bundle check an extracted bundle directory (used by deploy.sh).

Determinism scope: identical source pins, toolchain, ROS distro and vendor
inputs produce a byte-identical archive (fixed entry order, owner, modes
and mtime, timestampless gzip). Different compiler/ROS patch releases are
not guaranteed bit-for-bit identical.

The script is staged into every bundle under tools/ so the robot can verify
a bundle without the source repository. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime
import gzip
import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import xml.etree.ElementTree as ET

MANIFEST_SCHEMA = "rosdeck.release-manifest/1"
SBOM_SPEC_VERSION = "1.5"
GENERATED_FILES = ("release-manifest.json", "sbom.json", "manifest.env")
SIGNATURE_SUFFIX = ".asc"
CHECKSUM_SUFFIX = ".sha256"
TREE_SKIP_DIRS = {".git", "build", "__pycache__", ".pytest_cache"}
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TREE_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MANIFEST_REQUIRED_KEYS = (
    "artifact",
    "version",
    "profile",
    "model",
    "arch",
    "ros_distro",
    "source_epoch",
    "epoch_origin",
    "sources",
    "tools",
    "system_dependencies",
    "workspace_packages",
    "config",
)


def die(message):
    print("release_artifacts: " + message, file=sys.stderr)
    sys.exit(1)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_sha256(root):
    """Content hash of a directory tree (sorted, metadata-free).

    Skips VCS/build noise so a re-extracted vendor drop pins to the same
    hash as the one on the build machine.
    """
    digest = hashlib.sha256()
    root = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in TREE_SKIP_DIRS)
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            digest.update(rel.encode("utf-8") + b"\0")
            with open(full, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def git_toplevel(path):
    # Works from any subdirectory of a checkout, not only the root; a
    # monorepo package (e.g. robot/rosdeck_robot_bridge) must pin to the
    # enclosing repo's HEAD.
    try:
        result = run(["git", "-C", path, "rev-parse", "--show-toplevel"],
                     timeout=15)
    except subprocess.SubprocessError:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return os.path.realpath(result.stdout.strip())


def git_head(path):
    result = run(["git", "-C", path, "rev-parse", "HEAD"])
    if result.returncode != 0 or not GIT_SHA_RE.match(result.stdout.strip()):
        return None
    return result.stdout.strip()


def git_dirty(toplevel, scope):
    # The pathspec is relative to the working directory, so run from the
    # toplevel with the toplevel-relative scope.
    result = run(["git", "-C", toplevel, "status", "--porcelain", "--", scope])
    return result.returncode == 0 and result.stdout.strip() != ""


def pin_source(name, value):
    """Turn a `path|url` (or `part-of:other`) spec into a manifest pin."""
    if value.startswith("part-of:"):
        ref = value.split(":", 1)[1]
        if not ref:
            die("source %s: empty part-of reference" % name)
        return {"name": name, "kind": "part-of", "ref": ref}
    path, _, url = value.partition("|")
    url = url or None
    if not os.path.isdir(path):
        die("source %s: not a directory: %s" % (name, path))
    toplevel = git_toplevel(path)
    if toplevel is not None:
        head = git_head(path)
        if head is None:
            die("source %s: git repository has no HEAD: %s" % (name, path))
        scope = os.path.relpath(os.path.realpath(path), toplevel) or "."
        return {
            "name": name,
            "kind": "git",
            "sha": head,
            "dirty": git_dirty(toplevel, scope),
            "url": url,
        }
    return {"name": name, "kind": "tree", "sha256": tree_sha256(path), "url": url}


def command_version(cmd, *args):
    path = shutil.which(cmd)
    if not path:
        return "unavailable"
    try:
        result = run([path, *args], timeout=30)
        lines = (result.stdout or result.stderr or "").strip().splitlines()
        if result.returncode == 0 and lines:
            return lines[0].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "unavailable"


def system_dependencies(ros_distro):
    if not shutil.which("dpkg-query"):
        return []
    try:
        result = run([
            "dpkg-query", "-W", "-f", "${Package} ${Version}\n",
            "ros-%s-*" % ros_distro,
        ])
    except OSError:
        return []
    deps = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2:
            deps.append({"name": parts[0], "version": parts[1]})
    return sorted(deps, key=lambda dep: dep["name"])


def workspace_packages(stage):
    """Workspace packages from the staged colcon merge-install."""
    share = os.path.join(stage, "runtime", "share")
    packages = []
    if not os.path.isdir(share):
        return packages
    for entry in sorted(os.listdir(share)):
        xml_path = os.path.join(share, entry, "package.xml")
        if not os.path.isfile(xml_path):
            continue
        try:
            root = ET.parse(xml_path).getroot()
        except ET.ParseError:
            continue
        name = (root.findtext("name") or "").strip() or entry
        version = (root.findtext("version") or "").strip() or "unknown"
        packages.append({"name": name, "version": version})
    return packages


def build_manifest(facts, packages, system_deps, tools, config, signature):
    epoch = int(facts["source_epoch"])
    return {
        "schema": MANIFEST_SCHEMA,
        "artifact": {"name": facts["bundle_name"], "format": "tar.gz"},
        "version": facts["version"],
        "profile": facts["profile"],
        "model": facts.get("model") or None,
        "arch": facts["arch"],
        "ros_distro": facts["ros_distro"],
        "source_epoch": epoch,
        "epoch_origin": facts.get("epoch_origin", "env"),
        "built_utc": datetime.datetime.fromtimestamp(
            epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": facts["sources"],
        "tools": tools,
        "system_dependencies": system_deps,
        "workspace_packages": packages,
        "config": config,
        "signature": signature,
    }


def build_sbom(facts, packages, system_deps):
    epoch = int(facts["source_epoch"])
    timestamp = datetime.datetime.fromtimestamp(
        epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    components = []
    for package in packages:
        components.append({
            "type": "library",
            "name": package["name"],
            "version": package["version"],
            "bom-ref": "workspace:%s" % package["name"],
            "purl": "pkg:generic/%s@%s" % (package["name"], package["version"]),
        })
    for dep in system_deps:
        components.append({
            "type": "library",
            "name": dep["name"],
            "version": dep["version"],
            "bom-ref": "system:%s" % dep["name"],
            "purl": "pkg:deb/ubuntu/%s@%s" % (dep["name"], dep["version"]),
        })
    for source in facts["sources"]:
        if source["kind"] == "part-of":
            continue
        version = (source.get("sha") or source.get("sha256") or "")[:12]
        entry = {
            "type": "library",
            "name": source["name"],
            "version": version or "unversioned",
            "bom-ref": "source:%s" % source["name"],
            "purl": "pkg:generic/%s@%s" % (source["name"], version or "unversioned"),
        }
        if source.get("url"):
            entry["externalReferences"] = [
                {"type": "vcs", "url": source["url"]}
            ]
        components.append(entry)
    return {
        "bomFormat": "CycloneDX",
        "specVersion": SBOM_SPEC_VERSION,
        "version": 1,
        "metadata": {
            "timestamp": timestamp,
            "component": {
                "type": "application",
                "name": facts["bundle_name"],
                "version": facts["version"],
                "purl": "pkg:generic/%s@%s"
                        % (facts["bundle_name"], facts["version"]),
            },
        },
        "components": components,
    }


def write_manifest_env(stage, facts):
    lines = [
        "BUNDLE_VERSION=%s" % facts["version"],
        "BUNDLE_PROFILE=%s" % facts["profile"],
        "BUNDLE_ARCH=%s" % facts["arch"],
        "BUNDLE_ROS_DISTRO=%s" % facts["ros_distro"],
        "BUNDLE_ZSIBOT_MODEL=%s" % (facts.get("model") or ""),
    ]
    with open(os.path.join(stage, "manifest.env"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def tar_entries(stage_parent, bundle_name):
    """(arcname, path) pairs: the top directory first, then every member in
    global lexicographic order. Symlinks to directories are emitted as
    symlink entries, never followed."""
    base = os.path.join(stage_parent, bundle_name)
    rels = [bundle_name]
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        dirnames.sort()
        names = list(filenames)
        for name in list(dirnames):
            if os.path.islink(os.path.join(dirpath, name)):
                dirnames.remove(name)
                names.append(name)
        for name in sorted(names):
            full = os.path.join(dirpath, name)
            rels.append(os.path.relpath(full, stage_parent)
                        .replace(os.sep, "/"))
    rels.sort(key=lambda rel: (rel != bundle_name, rel))
    return [(rel, os.path.join(stage_parent, rel)) for rel in rels]


def write_deterministic_tar(stage_parent, bundle_name, epoch, out_path):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w",
                      format=tarfile.PAX_FORMAT) as tar:
        for arcname, path in tar_entries(stage_parent, bundle_name):
            st = os.lstat(path)
            if stat.S_ISDIR(st.st_mode) and not arcname.endswith("/"):
                arcname += "/"
            info = tarfile.TarInfo(arcname)
            info.mtime = epoch
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            if stat.S_ISDIR(st.st_mode):
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            elif stat.S_ISLNK(st.st_mode):
                info.type = tarfile.SYMTYPE
                info.linkname = os.readlink(path)
                info.mode = 0o777
                tar.addfile(info)
            else:
                info.type = tarfile.REGTYPE
                info.size = st.st_size
                # Normalize modes so host umask cannot leak into the archive.
                info.mode = 0o755 if (st.st_mode & 0o111) else 0o644
                with open(path, "rb") as handle:
                    tar.addfile(info, handle)
    with open(out_path, "wb") as out:
        # mtime=0 and empty filename keep the gzip header deterministic.
        with gzip.GzipFile(filename="", mode="wb", fileobj=out,
                           compresslevel=9, mtime=0) as gz:
            gz.write(buffer.getvalue())


def gpg_available():
    return shutil.which("gpg") is not None


def gpg_fingerprint(key, gnupghome=None):
    env = os.environ.copy()
    if gnupghome:
        env["GNUPGHOME"] = gnupghome
    result = run(["gpg", "--batch", "--with-colons", "--list-keys", key],
                 env=env)
    if result.returncode != 0:
        die("gpg key not found in keyring: %s\n%s" % (key, result.stderr.strip()))
    for line in result.stdout.splitlines():
        if line.startswith("fpr:"):
            return line.split(":")[9]
    die("could not read gpg fingerprint for key: %s" % key)


def sign_archive(archive, key, gnupghome=None):
    if not gpg_available():
        die("gpg is required to sign; install gnupg first")
    env = os.environ.copy()
    if gnupghome:
        env["GNUPGHOME"] = gnupghome
    asc = archive + SIGNATURE_SUFFIX
    result = run([
        "gpg", "--batch", "--yes", "--pinentry-mode", "loopback",
        "--armor", "--detach-sign", "--local-user", key,
        "--output", asc, archive,
    ], env=env)
    if result.returncode != 0:
        die("gpg signing failed: %s" % result.stderr.strip())
    return asc


def verify_signature(asc, archive, gnupghome=None):
    if not gpg_available():
        return False, "gpg is not available; cannot verify signature"
    env = os.environ.copy()
    if gnupghome:
        env["GNUPGHOME"] = gnupghome
    result = run(["gpg", "--batch", "--verify", asc, archive], env=env)
    if result.returncode != 0:
        return False, "gpg signature verification failed:\n" + result.stderr.strip()
    return True, "gpg signature verified"


def extract_archive(archive, dest):
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            target = os.path.realpath(os.path.join(dest, member.name))
            root = os.path.realpath(dest)
            if target != root and not target.startswith(root + os.sep):
                die("archive contains an unsafe path: %s" % member.name)
        tar.extractall(dest)


def verify_bundle_dir(bundle_dir, expected_name=None):
    """Return (ok, messages) for an extracted bundle directory."""
    messages = []
    manifest_path = os.path.join(bundle_dir, "release-manifest.json")
    if not os.path.isfile(manifest_path):
        return False, ["release-manifest.json is missing"]
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        return False, ["release-manifest.json is not valid JSON: %s" % exc]
    if manifest.get("schema") != MANIFEST_SCHEMA:
        return False, [
            "unsupported manifest schema: %r (want %s)"
            % (manifest.get("schema"), MANIFEST_SCHEMA)
        ]

    errors = []
    for key in MANIFEST_REQUIRED_KEYS:
        if key not in manifest:
            errors.append("manifest is missing key: %s" % key)
    if expected_name is not None and \
            manifest.get("artifact", {}).get("name") != expected_name:
        errors.append(
            "manifest artifact name %r does not match bundle directory %r"
            % (manifest.get("artifact", {}).get("name"), expected_name))

    seen_sources = set()
    for source in manifest.get("sources", []):
        name = source.get("name", "?")
        kind = source.get("kind")
        if name in seen_sources:
            errors.append("duplicate source name: %s" % name)
        seen_sources.add(name)
        if kind == "git":
            if not GIT_SHA_RE.match(source.get("sha", "")):
                errors.append("source %s: invalid git sha" % name)
            if not isinstance(source.get("dirty"), bool):
                errors.append("source %s: dirty flag must be a boolean" % name)
        elif kind == "tree":
            if not TREE_SHA_RE.match(source.get("sha256", "")):
                errors.append("source %s: invalid tree sha256" % name)
        elif kind == "part-of":
            if not source.get("ref"):
                errors.append("source %s: part-of needs a ref" % name)
        else:
            errors.append("source %s: unknown kind %r" % (name, kind))

    config_path = os.path.join(bundle_dir, "config", "bridge.yaml")
    want = manifest.get("config", {}).get("bridge_yaml", {}).get("sha256")
    if not os.path.isfile(config_path):
        errors.append("config/bridge.yaml is missing")
    elif want is not None and sha256_file(config_path) != want:
        errors.append("config/bridge.yaml does not match the manifest hash")

    for package in manifest.get("workspace_packages", []):
        pkg_xml = os.path.join(bundle_dir, "runtime", "share",
                               package.get("name", ""), "package.xml")
        if not os.path.isfile(pkg_xml):
            errors.append("workspace package not staged: %s" % package.get("name"))

    sbom_path = os.path.join(bundle_dir, "sbom.json")
    if not os.path.isfile(sbom_path):
        errors.append("sbom.json is missing")
    else:
        try:
            with open(sbom_path, "r", encoding="utf-8") as handle:
                sbom = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            errors.append("sbom.json is not valid JSON: %s" % exc)
        else:
            if sbom.get("bomFormat") != "CycloneDX" or \
                    sbom.get("specVersion") != SBOM_SPEC_VERSION:
                errors.append("sbom.json is not CycloneDX %s" % SBOM_SPEC_VERSION)

    env_path = os.path.join(bundle_dir, "manifest.env")
    if os.path.isfile(env_path):
        env_values = {}
        with open(env_path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env_values[key] = value
        checks = (
            ("BUNDLE_VERSION", manifest.get("version")),
            ("BUNDLE_PROFILE", manifest.get("profile")),
            ("BUNDLE_ARCH", manifest.get("arch")),
            ("BUNDLE_ROS_DISTRO", manifest.get("ros_distro")),
        )
        for key, want_value in checks:
            if env_values.get(key) != want_value:
                errors.append(
                    "manifest.env %s=%r does not match manifest %r"
                    % (key, env_values.get(key), want_value))

    if errors:
        return False, ["release-manifest.json: " + error for error in errors]
    messages.append(
        "bundle manifest consistent (%d sources, %d workspace packages)"
        % (len(manifest.get("sources", [])),
           len(manifest.get("workspace_packages", []))))
    return True, messages


def cmd_facts(args):
    if not os.path.isdir(args.stage):
        die("stage directory does not exist: %s" % args.stage)
    if os.path.basename(os.path.abspath(args.stage)) != args.bundle_name:
        die("stage directory name %r does not match bundle name %r"
            % (os.path.basename(os.path.abspath(args.stage)), args.bundle_name))
    sources = []
    for spec in args.source:
        name, _, value = spec.partition("=")
        if not name or not value:
            die("bad --source spec (want name=path|url): %s" % spec)
        sources.append(pin_source(name, value))
    facts = {
        "stage": os.path.abspath(args.stage),
        "bundle_name": args.bundle_name,
        "version": args.version,
        "profile": args.profile,
        "model": args.model or None,
        "arch": args.arch,
        "ros_distro": args.distro,
        "source_epoch": int(args.epoch),
        "epoch_origin": args.epoch_origin,
        "sign_key": args.sign_key,
        "sources": sources,
    }
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(facts, handle, indent=2)
        handle.write("\n")
    print("release facts written: %s" % args.output)
    for source in sources:
        pin = source.get("sha") or source.get("sha256") or source.get("ref")
        print("  %s [%s] %s" % (source["name"], source["kind"], pin))


def cmd_make(args):
    with open(args.facts, "r", encoding="utf-8") as handle:
        facts = json.load(handle)
    for key in ("stage", "bundle_name", "version", "profile", "arch",
                "ros_distro", "source_epoch", "sources"):
        if key not in facts:
            die("facts file is missing key: %s" % key)
    stage = os.path.abspath(facts["stage"])
    if not os.path.isdir(stage):
        die("stage directory does not exist: %s" % stage)
    if os.path.basename(stage) != facts["bundle_name"]:
        die("stage directory name does not match bundle name")
    try:
        int(facts["source_epoch"])
    except (TypeError, ValueError):
        die("source_epoch must be an integer")

    for name in GENERATED_FILES:
        stale = os.path.join(stage, name)
        if os.path.exists(stale):
            os.remove(stale)

    packages = workspace_packages(stage)
    system_deps = system_dependencies(facts["ros_distro"])
    tools = {
        "colcon": command_version("colcon", "--version"),
        "cmake": command_version("cmake", "--version"),
        "g++": command_version("g++", "--version"),
        "python3": platform.python_version(),
    }
    config_path = os.path.join(stage, "config", "bridge.yaml")
    if not os.path.isfile(config_path):
        die("stage is missing config/bridge.yaml")
    config = {"bridge_yaml": {
        "sha256": sha256_file(config_path),
        "bytes": os.path.getsize(config_path),
    }}
    signature = None
    if facts.get("sign_key"):
        fingerprint = gpg_fingerprint(facts["sign_key"])
        signature = {
            "method": "gpg",
            "key_fingerprint": fingerprint,
            "file": facts["bundle_name"] + ".tar.gz" + SIGNATURE_SUFFIX,
        }
    manifest = build_manifest(facts, packages, system_deps, tools, config,
                              signature)
    sbom = build_sbom(facts, packages, system_deps)
    with open(os.path.join(stage, "release-manifest.json"), "w",
              encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    with open(os.path.join(stage, "sbom.json"), "w", encoding="utf-8") as handle:
        json.dump(sbom, handle, indent=2)
        handle.write("\n")
    write_manifest_env(stage, facts)

    out_dir = os.path.abspath(args.output_dir)
    os.makedirs(out_dir, exist_ok=True)
    archive = os.path.join(out_dir, facts["bundle_name"] + ".tar.gz")
    stage_parent = os.path.dirname(stage)
    write_deterministic_tar(stage_parent, facts["bundle_name"],
                            int(facts["source_epoch"]), archive)
    checksum_path = archive + CHECKSUM_SUFFIX
    with open(checksum_path, "w", encoding="utf-8") as handle:
        handle.write("%s  %s\n" % (sha256_file(archive), os.path.basename(archive)))

    print("release manifest: %s" % os.path.join(stage, "release-manifest.json"))
    print("sbom:             %s" % os.path.join(stage, "sbom.json"))
    print("archive:          %s" % archive)
    print("checksum:         %s" % checksum_path)
    if facts.get("sign_key"):
        asc = sign_archive(archive, facts["sign_key"])
        print("signature:        %s" % asc)


def cmd_sign(args):
    if not os.path.isfile(args.archive):
        die("archive not found: %s" % args.archive)
    asc = sign_archive(os.path.abspath(args.archive), args.key)
    print("signature: %s" % asc)


def cmd_verify(args):
    archive = os.path.abspath(args.archive)
    if not os.path.isfile(archive):
        die("archive not found: %s" % archive)
    errors = []
    notes = []

    checksum_path = archive + CHECKSUM_SUFFIX
    if os.path.isfile(checksum_path):
        with open(checksum_path, "r", encoding="utf-8") as handle:
            line = handle.read().strip()
        expected, _, recorded_name = line.partition("  ")
        actual = sha256_file(archive)
        if actual != expected.strip():
            errors.append("sha256 mismatch: %s (manifest says %s)"
                          % (actual, expected.strip()))
        elif recorded_name and recorded_name != os.path.basename(archive):
            errors.append("sha256 sidecar names %r, not %r"
                          % (recorded_name, os.path.basename(archive)))
        else:
            notes.append("sha256 matches %s" % CHECKSUM_SUFFIX)
    else:
        notes.append("no %s sidecar found; hash check skipped" % CHECKSUM_SUFFIX)

    asc = args.signature
    if asc is None and os.path.isfile(archive + SIGNATURE_SUFFIX):
        asc = archive + SIGNATURE_SUFFIX
    if asc:
        if not os.path.isfile(asc):
            errors.append("signature file not found: %s" % asc)
        else:
            ok, message = verify_signature(asc, archive)
            (notes if ok else errors).append(message)
    else:
        notes.append("no signature present; signature check skipped")

    with tempfile.TemporaryDirectory(prefix="rosdeck-verify.") as temp:
        try:
            extract_archive(archive, temp)
        except tarfile.TarError as exc:
            die("cannot extract archive: %s" % exc)
        entries = [entry for entry in os.listdir(temp)
                   if os.path.isdir(os.path.join(temp, entry))]
        if len(entries) != 1:
            die("archive must contain exactly one top-level directory")
        ok, messages = verify_bundle_dir(os.path.join(temp, entries[0]),
                                         expected_name=None)
        if ok:
            notes.extend(messages)
        else:
            errors.extend(messages)

    for note in notes:
        print("[ok]   %s" % note)
    if errors:
        for error in errors:
            print("[fail] %s" % error, file=sys.stderr)
        die("verification FAILED for %s" % archive)
    print("VERIFIED %s" % os.path.basename(archive))


def cmd_verify_bundle(args):
    bundle_dir = os.path.abspath(args.bundle_dir)
    if not os.path.isdir(bundle_dir):
        die("bundle directory not found: %s" % bundle_dir)
    ok, messages = verify_bundle_dir(bundle_dir,
                                     expected_name=os.path.basename(bundle_dir))
    for message in messages:
        print(("[ok]   " if ok else "[fail] ") + message)
    if not ok:
        die("bundle verification FAILED for %s" % bundle_dir)
    print("BUNDLE VERIFIED %s" % os.path.basename(bundle_dir))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    facts = sub.add_parser("facts", help="pin build inputs into a facts JSON")
    facts.add_argument("--stage", required=True, help="staged bundle directory")
    facts.add_argument("--bundle-name", required=True)
    facts.add_argument("--version", required=True)
    facts.add_argument("--profile", required=True, choices=["vbot", "zsibot"])
    facts.add_argument("--model", default="", choices=["", "zsl-1", "zsl-1w"])
    facts.add_argument("--arch", required=True, help="target architecture (uname -m)")
    facts.add_argument("--distro", required=True, help="ROS distribution")
    facts.add_argument("--epoch", required=True, type=int,
                       help="SOURCE_DATE_EPOCH for reproducible metadata")
    facts.add_argument("--epoch-origin", required=True,
                       choices=["env", "git", "file-mtime"])
    facts.add_argument("--sign-key", default=None,
                       help="gpg key id/fingerprint to sign with during make")
    facts.add_argument("--source", action="append", default=[],
                       help="name=path|url, name=path, or name=part-of:other "
                            "(repeatable)")
    facts.add_argument("--output", required=True, help="facts JSON output path")
    facts.set_defaults(func=cmd_facts)

    make = sub.add_parser("make", help="manifest + SBOM + deterministic archive")
    make.add_argument("--facts", required=True)
    make.add_argument("--output-dir", required=True)
    make.set_defaults(func=cmd_make)

    sign = sub.add_parser("sign", help="detached-sign an existing archive")
    sign.add_argument("archive")
    sign.add_argument("--key", required=True)
    sign.set_defaults(func=cmd_sign)

    verify = sub.add_parser("verify", help="verify an archive end to end")
    verify.add_argument("archive")
    verify.add_argument("--signature", default=None,
                        help="signature path (default: <archive>.asc if present)")
    verify.set_defaults(func=cmd_verify)

    verify_bundle = sub.add_parser("verify-bundle",
                                   help="verify an extracted bundle directory")
    verify_bundle.add_argument("bundle_dir")
    verify_bundle.set_defaults(func=cmd_verify_bundle)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()