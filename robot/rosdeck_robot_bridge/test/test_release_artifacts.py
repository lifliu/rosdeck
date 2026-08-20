"""Tests for scripts/release_artifacts.py (manifest, SBOM, determinism,
integrity and GPG signing).

Runs with the standard library only:
  python3 -m unittest robot/rosdeck_robot_bridge/test/test_release_artifacts.py

The GPG round-trip skips itself when gpg is not installed (it runs in CI).
"""

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "scripts", "release_artifacts.py"))

BUNDLE_NAME = "rosdeck-robot-bridge-0.0.0-test-aarch64-humble"
EPOCH = 1767225600  # 2026-01-01T00:00:00Z, fixed for reproducibility
DISTRO = "humble"
PROFILE = "vbot"

PACKAGE_XML_TEMPLATE = """<?xml version="1.0"?>
<package format="3">
  <name>{name}</name>
  <version>{version}</version>
  <description>test package {name}</description>
</package>
"""


def make_stage(stage_dir):
    """Build a fake but structurally complete bundle stage."""
    os.makedirs(os.path.join(stage_dir, "bin"), exist_ok=True)
    os.makedirs(os.path.join(stage_dir, "config"), exist_ok=True)
    os.makedirs(os.path.join(stage_dir, "templates"), exist_ok=True)
    os.makedirs(os.path.join(stage_dir, "tools"), exist_ok=True)
    for package, version in (
        ("rosdeck_robot_bridge", "0.0.0"),
        ("omni_robot_interfaces", "0.1.0"),
        ("omni_slam_interfaces", "0.1.0"),
    ):
        share = os.path.join(stage_dir, "runtime", "share", package)
        os.makedirs(share, exist_ok=True)
        with open(os.path.join(share, "package.xml"), "w", encoding="utf-8") as handle:
            handle.write(PACKAGE_XML_TEMPLATE.format(name=package, version=version))
    with open(os.path.join(stage_dir, "bin", "rosdeck_robot_bridge_node"), "w",
              encoding="utf-8") as handle:
        handle.write("#!/bin/sh\nexit 0\n")
    os.chmod(os.path.join(stage_dir, "bin", "rosdeck_robot_bridge_node"), 0o755)
    with open(os.path.join(stage_dir, "config", "bridge.yaml"), "w",
              encoding="utf-8") as handle:
        handle.write("node:\n  name: rosdeck_robot_bridge\n")
    with open(os.path.join(stage_dir, "runtime", "local_setup.bash"), "w",
              encoding="utf-8") as handle:
        handle.write("# fake local setup\n")
    with open(os.path.join(stage_dir, "templates", "run-bridge.in"), "w",
              encoding="utf-8") as handle:
        handle.write("#!/bin/sh\n# template\n")
    shutil.copy(SCRIPT, os.path.join(stage_dir, "tools", "release_artifacts.py"))


def run_tool(args, env=None):
    return subprocess.run(
        [sys.executable, SCRIPT] + args,
        capture_output=True, text=True, env=env, check=False)


def write_facts(stage, out_path, sources, sign_key=None, model=""):
    args = [
        "facts", "--stage", stage, "--bundle-name", BUNDLE_NAME,
        "--version", "0.0.0", "--profile", PROFILE,
        "--arch", "aarch64", "--distro", DISTRO,
        "--epoch", str(EPOCH), "--epoch-origin", "env",
        "--output", out_path,
    ]
    if sign_key:
        args += ["--sign-key", sign_key]
    if model:
        args += ["--model", model]
    for spec in sources:
        args += ["--source", spec]
    result = run_tool(args)
    if result.returncode != 0:
        raise AssertionError("facts failed:\n%s%s"
                             % (result.stdout, result.stderr))
    return out_path


class TestReleaseArtifacts(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="rosdeck-rel.")
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def make_bundle(self, area, stage_sources, sign_key=None, out_sub="out"):
        """facts + make in a fresh area; returns (stage, archive, out_dir)."""
        area = os.path.join(self.root, area)
        os.makedirs(area, exist_ok=True)
        stage = os.path.join(area, BUNDLE_NAME)
        make_stage(stage)
        facts_path = os.path.join(area, "facts.json")
        write_facts(stage, facts_path, stage_sources, sign_key=sign_key)
        out_dir = os.path.join(area, out_sub)
        result = run_tool(["make", "--facts", facts_path, "--output-dir", out_dir])
        if result.returncode != 0:
            raise AssertionError("make failed:\n%s%s"
                                 % (result.stdout, result.stderr))
        archive = os.path.join(out_dir, BUNDLE_NAME + ".tar.gz")
        self.assertTrue(os.path.isfile(archive))
        return stage, archive, out_dir

    def make_sources(self, area):
        """A git checkout, a tree (vendor) dir and a part-of reference."""
        if shutil.which("git") is None:
            self.skipTest("git is not available")
        git_dir = os.path.join(self.root, area, "src", "rosdeck")
        os.makedirs(git_dir)
        env = dict(os.environ)
        env.update({
            "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "t@example.com",
            "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
        })

        def git(*args):
            result = subprocess.run(["git", "-C", git_dir] + list(args),
                                    capture_output=True, text=True, env=env)
            if result.returncode != 0:
                raise AssertionError("git %s failed: %s"
                                     % (args, result.stderr))
            return result

        git("init", "-q")
        with open(os.path.join(git_dir, "package.xml"), "w", encoding="utf-8") as handle:
            handle.write("<package/>")
        git("add", "-A")
        git("commit", "-qm", "test commit")
        sha = git("rev-parse", "HEAD").stdout.strip()

        tree_dir = os.path.join(self.root, area, "src", "vbot_ros2_msgs")
        os.makedirs(os.path.join(tree_dir, "msg"))
        with open(os.path.join(tree_dir, "msg", "Heartbeat.msg"), "w",
                  encoding="utf-8") as handle:
            handle.write("int32 seq\n")
        with open(os.path.join(tree_dir, "package.xml"), "w", encoding="utf-8") as handle:
            handle.write("<package/>")
        return [
            "rosdeck=%s|https://github.com/lifliu/rosdeck.git" % git_dir,
            "vbot_ros2_msgs=%s" % tree_dir,
            "omni_mission_manager=part-of:rosdeck",
        ], sha

    def test_facts_pins_sources(self):
        sources, sha = self.make_sources("facts")
        stage = os.path.join(self.root, "facts", BUNDLE_NAME)
        make_stage(stage)
        facts_path = os.path.join(self.root, "facts", "facts.json")
        write_facts(stage, facts_path, sources)
        with open(facts_path, "r", encoding="utf-8") as handle:
            facts = json.load(handle)
        by_name = {source["name"]: source for source in facts["sources"]}
        self.assertEqual(by_name["rosdeck"]["kind"], "git")
        self.assertEqual(by_name["rosdeck"]["sha"], sha)
        self.assertFalse(by_name["rosdeck"]["dirty"])
        self.assertEqual(by_name["rosdeck"]["url"],
                         "https://github.com/lifliu/rosdeck.git")
        self.assertEqual(by_name["vbot_ros2_msgs"]["kind"], "tree")
        self.assertRegex(by_name["vbot_ros2_msgs"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(by_name["omni_mission_manager"]["kind"], "part-of")
        self.assertEqual(by_name["omni_mission_manager"]["ref"], "rosdeck")
        self.assertEqual(facts["source_epoch"], EPOCH)

    def test_facts_subdirectory_pin_is_repo_scoped(self):
        # A monorepo package directory must pin to the enclosing repo's
        # HEAD, and the dirty flag must only reflect its own subdirectory.
        if shutil.which("git") is None:
            self.skipTest("git is not available")
        repo = os.path.join(self.root, "subpin")
        os.makedirs(os.path.join(repo, "sub"))
        env = dict(os.environ)
        env.update({
            "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "t@example.com",
            "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "t@example.com",
            "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
        })

        def git(*args):
            result = subprocess.run(["git", "-C", repo] + list(args),
                                    capture_output=True, text=True, env=env)
            if result.returncode != 0:
                raise AssertionError("git %s failed: %s"
                                     % (args, result.stderr))
            return result

        git("init", "-q")
        with open(os.path.join(repo, "top.txt"), "w", encoding="utf-8") as handle:
            handle.write("top\n")
        with open(os.path.join(repo, "sub", "inner.txt"), "w",
                  encoding="utf-8") as handle:
            handle.write("inner\n")
        git("add", "-A")
        git("commit", "-qm", "init")
        sha = git("rev-parse", "HEAD").stdout.strip()

        # The stage must live outside the repo or it would count as dirty.
        stage = os.path.join(self.root, "subpin-stage", BUNDLE_NAME)
        make_stage(stage)
        source = ("rosdeck=%s|https://github.com/lifliu/rosdeck.git"
                  % os.path.join(repo, "sub"))

        def pin():
            facts_path = os.path.join(self.root, "subpin-stage", "facts.json")
            write_facts(stage, facts_path, [source])
            with open(facts_path, "r", encoding="utf-8") as handle:
                return json.load(handle)["sources"][0]

        pinned = pin()
        self.assertEqual(pinned["kind"], "git")
        self.assertEqual(pinned["sha"], sha)
        self.assertFalse(pinned["dirty"])

        with open(os.path.join(repo, "top.txt"), "a",
                  encoding="utf-8") as handle:
            handle.write("outside the pin scope\n")
        self.assertFalse(pin()["dirty"])

        with open(os.path.join(repo, "sub", "inner.txt"), "a",
                  encoding="utf-8") as handle:
            handle.write("inside the pin scope\n")
        self.assertTrue(pin()["dirty"])

    def test_deterministic_archive(self):
        # Two independently staged, identically pinned builds must hash the
        # same. Areas live in different directories to prove the path does
        # not leak into the archive.
        sources_a, _ = self.make_sources("det-a")
        sources_b, _ = self.make_sources("det-b")
        _, archive_a, _ = self.make_bundle("det-a", sources_a)
        _, archive_b, _ = self.make_bundle("det-b", sources_b)
        with open(archive_a, "rb") as handle:
            blob_a = handle.read()
        with open(archive_b, "rb") as handle:
            blob_b = handle.read()
        self.assertEqual(blob_a, blob_b)

        # Entry metadata must be normalized.
        with tarfile.open(archive_a, "r:gz") as tar:
            members = tar.getmembers()
            names = [member.name for member in members]
            self.assertEqual(names[0], BUNDLE_NAME)
            self.assertEqual(names, sorted(names, key=lambda n: (n != BUNDLE_NAME, n)))
            for member in members:
                self.assertEqual(member.mtime, EPOCH)
                self.assertEqual((member.uid, member.gid), (0, 0))
                self.assertEqual((member.uname, member.gname), ("", ""))

    def test_verify_roundtrip_and_tamper(self):
        sources, _ = self.make_sources("verify")
        _, archive, out_dir = self.make_bundle("verify", sources)
        result = run_tool(["verify", archive])
        self.assertEqual(result.returncode, 0,
                         "verify should pass:\n%s%s" % (result.stdout, result.stderr))
        self.assertIn("VERIFIED", result.stdout)

        # Tamper one byte mid-archive: checksum must catch it.
        with open(archive, "rb") as handle:
            blob = bytearray(handle.read())
        blob[len(blob) // 2] ^= 0xFF
        with open(archive, "wb") as handle:
            handle.write(blob)
        result = run_tool(["verify", archive])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("sha256 mismatch", result.stderr)

    def test_verify_bundle_detects_config_tamper(self):
        sources, _ = self.make_sources("vb")
        stage, archive, _ = self.make_bundle("vb", sources)
        extract_dir = os.path.join(self.root, "vb", "extracted")
        os.makedirs(extract_dir)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(extract_dir)
        bundle = os.path.join(extract_dir, BUNDLE_NAME)

        with open(os.path.join(bundle, "release-manifest.json"), "r",
                  encoding="utf-8") as handle:
            manifest = json.load(handle)
        self.assertEqual(manifest["schema"], "rosdeck.release-manifest/1")
        self.assertEqual(manifest["version"], "0.0.0")
        self.assertEqual(manifest["profile"], PROFILE)
        self.assertEqual(manifest["arch"], "aarch64")
        self.assertEqual(manifest["ros_distro"], DISTRO)
        self.assertEqual(manifest["source_epoch"], EPOCH)
        package_names = {p["name"] for p in manifest["workspace_packages"]}
        self.assertIn("rosdeck_robot_bridge", package_names)
        self.assertIn("omni_robot_interfaces", package_names)

        with open(os.path.join(bundle, "sbom.json"), "r", encoding="utf-8") as handle:
            sbom = json.load(handle)
        self.assertEqual(sbom["bomFormat"], "CycloneDX")
        self.assertEqual(sbom["specVersion"], "1.5")
        self.assertEqual(sbom["metadata"]["component"]["name"], BUNDLE_NAME)

        with open(os.path.join(bundle, "manifest.env"),
                     encoding="utf-8") as handle:
            env_text = handle.read()
        for line in ("BUNDLE_VERSION=0.0.0", "BUNDLE_PROFILE=vbot",
                     "BUNDLE_ARCH=aarch64", "BUNDLE_ROS_DISTRO=humble",
                     "BUNDLE_ZSIBOT_MODEL="):
            self.assertIn(line, env_text)

        result = run_tool(["verify-bundle", bundle])
        self.assertEqual(result.returncode, 0,
                         "verify-bundle should pass:\n%s%s"
                         % (result.stdout, result.stderr))

        with open(os.path.join(bundle, "config", "bridge.yaml"), "a",
                  encoding="utf-8") as handle:
            handle.write("tampered: true\n")
        result = run_tool(["verify-bundle", bundle])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bridge.yaml", result.stdout)

    def test_verify_bundle_rejects_legacy_stage_without_manifest(self):
        legacy = os.path.join(self.root, "legacy", BUNDLE_NAME)
        os.makedirs(os.path.join(legacy, "config"), exist_ok=True)
        os.makedirs(os.path.join(legacy, "bin"), exist_ok=True)
        with open(os.path.join(legacy, "config", "bridge.yaml"), "w",
                  encoding="utf-8") as handle:
            handle.write("node: {}\n")
        result = run_tool(["verify-bundle", legacy])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("release-manifest.json is missing", result.stdout)

    def test_gpg_sign_and_verify_roundtrip(self):
        if shutil.which("gpg") is None:
            self.skipTest("gpg is not installed")
        gnupghome = os.path.join(self.root, "gnupg")
        os.makedirs(gnupghome, mode=0o700)
        env = dict(os.environ)
        env["GNUPGHOME"] = gnupghome
        result = subprocess.run(
            ["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "",
             "--quick-generate-key", "Release Test <release@example.com>",
             "ed25519", "sign", "never"],
            capture_output=True, text=True, env=env)
        if result.returncode != 0:
            self.skipTest("could not create test key: %s" % result.stderr)
        fingerprint = subprocess.run(
            ["gpg", "--batch", "--with-colons", "--list-keys",
             "release@example.com"],
            capture_output=True, text=True, env=env).stdout
        fingerprint = next(line.split(":")[9] for line in fingerprint.splitlines()
                           if line.startswith("fpr:"))

        sources, _ = self.make_sources("gpg")
        _, archive, out_dir = self.make_bundle("gpg", sources,
                                               sign_key=fingerprint)
        asc = archive + ".asc"
        self.assertTrue(os.path.isfile(asc))

        # The manifest records the signing key before the archive is built.
        with tarfile.open(archive, "r:gz") as tar:
            member = tar.extractfile(BUNDLE_NAME + "/release-manifest.json")
            manifest = json.load(member)
        self.assertEqual(manifest["signature"]["method"], "gpg")
        self.assertEqual(manifest["signature"]["key_fingerprint"], fingerprint)
        self.assertEqual(manifest["signature"]["file"],
                         BUNDLE_NAME + ".tar.gz" + ".asc")

        result = run_tool(["verify", archive], env=env)
        self.assertEqual(result.returncode, 0,
                         "signed verify should pass:\n%s%s"
                         % (result.stdout, result.stderr))
        self.assertIn("gpg signature verified", result.stdout)

        with open(archive, "rb") as handle:
            blob = bytearray(handle.read())
        blob[len(blob) // 2] ^= 0xFF
        with open(archive, "wb") as handle:
            handle.write(blob)
        result = run_tool(["verify", archive], env=env)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
