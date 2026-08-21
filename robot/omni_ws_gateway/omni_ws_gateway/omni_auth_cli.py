"""``omni-auth``: operator CLI for device TLS and user management.

Commands:
  init                        generate the device key + self-signed cert
                              (idempotent; ``--force`` regenerates)
  add-user NAME --role R      create a user, print the token ONCE
  list                        list users (role, created, expires)
  remove-user NAME            remove a user
  show-pairing                print the device cert PEM + SPKI pin the
                              mobile app must trust

Runs as root during deploy (the deployer calls ``init``) or as the
``rosdeck`` user for day-2 user management. When run as root, created
files are chowned to the ``rosdeck`` service account.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import socket
import subprocess
import sys

from .auth_store import ROLES, UserStore, chown_to_rosdeck

TLS_DIR_ENV = "OMNI_WS_TLS_DIR"
AUTH_DIR_ENV = "OMNI_WS_AUTH_DIR"
DEFAULT_TLS_DIR = "/var/lib/omni/tls"
DEFAULT_AUTH_DIR = "/var/lib/omni/auth"

CERT_DAYS = 3650


def _tls_dir() -> str:
    return os.environ.get(TLS_DIR_ENV, DEFAULT_TLS_DIR)


def _auth_dir() -> str:
    return os.environ.get(AUTH_DIR_ENV, DEFAULT_AUTH_DIR)


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout


def cmd_init(args: argparse.Namespace) -> int:
    tls_dir = _tls_dir()
    key_path = os.path.join(tls_dir, "device.key")
    crt_path = os.path.join(tls_dir, "device.crt")
    if os.path.exists(crt_path) and os.path.exists(key_path) and not args.force:
        print(f"device identity already exists at {tls_dir} "
              "(use --force to rotate)")
        return 0
    os.makedirs(tls_dir, mode=0o700, exist_ok=True)
    host = socket.gethostname() or "rosdeck-robot"
    print(f"generating ECDSA P-256 device key (CN={host}) ...")
    _run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout",
          "-out", key_path])
    os.chmod(key_path, 0o600)
    _run([
        "openssl", "req", "-new", "-x509",
        "-key", key_path,
        "-sha256",
        "-days", str(CERT_DAYS),
        "-subj", f"/CN={host}/O=Rosdeck",
        "-addext", f"subjectAltName=DNS:{host},IP:127.0.0.1",
        "-out", crt_path,
    ])
    os.chmod(crt_path, 0o644)
    chown_to_rosdeck(tls_dir, recursive=True)
    print(f"device certificate: {crt_path} (valid {CERT_DAYS} days)")
    print("pairing fingerprint for the mobile app:")
    print("  " + spki_fingerprint(crt_path))
    return 0


def spki_fingerprint(crt_path: str) -> str:
    """SHA-256 of the subject public key (DER), hex — the app's pin."""
    pub_pem = _run(["openssl", "x509", "-in", crt_path, "-pubkey", "-noout"])
    pub_der = subprocess.run(
        ["openssl", "pkey", "-pubin", "-outform", "DER"],
        input=pub_pem, capture_output=True, check=True,
    ).stdout
    return hashlib.sha256(pub_der).hexdigest()


def _store() -> UserStore:
    os.makedirs(_auth_dir(), mode=0o755, exist_ok=True)
    return UserStore(os.path.join(_auth_dir(), "users.json"))


def cmd_add_user(args: argparse.Namespace) -> int:
    try:
        token = _store().add_user(args.name, args.role, args.days)
    except ValueError as exc:
        print(f"omni-auth: {exc}", file=sys.stderr)
        return 2
    print(f"user {args.name!r} created (role={args.role})")
    print("token (shown ONCE, store it now):")
    print(f"  {token}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    store = _store()
    users = store.list_users()
    if not users:
        print("no users (omni-auth add-user <name> --role <role>)")
        return 0
    for user in users:
        expires = "never" if not user.expires else str(user.expires)
        print(f"{user.name:<24} role={user.role:<9} created={user.created} "
              f"expires={expires}")
    return 0


def cmd_remove_user(args: argparse.Namespace) -> int:
    if not _store().remove_user(args.name):
        print(f"omni-auth: no such user {args.name!r}", file=sys.stderr)
        return 2
    print(f"user {args.name!r} removed")
    return 0


def cmd_show_pairing(args: argparse.Namespace) -> int:
    crt_path = os.path.join(_tls_dir(), "device.crt")
    if not os.path.isfile(crt_path):
        print("omni-auth: no device certificate (run omni-auth init)",
              file=sys.stderr)
        return 3
    print(f"# device pairing for host {socket.gethostname()}")
    print("# SPKI SHA-256 pin (pin this in the mobile app):")
    print(f"#   {spki_fingerprint(crt_path)}")
    with open(crt_path, encoding="utf-8") as fh:
        sys.stdout.write(fh.read())
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="omni-auth")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="generate device TLS identity")
    p_init.add_argument("--force", action="store_true",
                        help="regenerate even if identity exists")
    p_init.set_defaults(func=cmd_init)

    p_add = sub.add_parser("add-user", help="create a user")
    p_add.add_argument("name")
    p_add.add_argument("--role", required=True, choices=ROLES)
    p_add.add_argument("--days", type=int, default=0,
                       help="token lifetime in days (0 = never)")
    p_add.set_defaults(func=cmd_add_user)

    p_list = sub.add_parser("list", help="list users")
    p_list.set_defaults(func=cmd_list)

    p_rm = sub.add_parser("remove-user", help="remove a user")
    p_rm.add_argument("name")
    p_rm.set_defaults(func=cmd_remove_user)

    p_pair = sub.add_parser("show-pairing",
                            help="print device cert + SPKI pin")
    p_pair.set_defaults(func=cmd_show_pairing)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
