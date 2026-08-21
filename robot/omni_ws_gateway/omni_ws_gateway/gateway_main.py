"""Entry point for the ``omni-ws-gateway`` console script.

Configuration comes from the environment (see the systemd unit's
EnvironmentFile):

  OMNI_WS_LISTEN     listen host:port          (default 0.0.0.0:8765)
  OMNI_WS_UPSTREAM   upstream host:port        (default 127.0.0.1:8766)
  OMNI_WS_TLS_DIR    cert/key directory        (default /var/lib/omni/tls)
  OMNI_WS_AUTH_DIR   users.json / policy dir   (default /var/lib/omni/auth)
  OMNI_WS_AUDIT_DIR  audit log directory       (default /var/lib/omni/audit)
  OMNI_WS_POLICY     optional policy.json path (default <AUTH_DIR>/policy.json)
  OMNI_WS_LOGIN_TIMEOUT  seconds               (default 10)
"""

from __future__ import annotations

import asyncio
import os
import sys

from .gateway import Gateway, GatewayConfig


def _host_port(value: str, default: str) -> tuple[str, int]:
    value = value.strip() or default
    host, _, port = value.rpartition(":")
    if not host or not port.isdigit():
        raise ValueError(f"invalid host:port value: {value!r}")
    return host, int(port)


def config_from_env() -> GatewayConfig:
    auth_dir = os.environ.get("OMNI_WS_AUTH_DIR", "/var/lib/omni/auth")
    listen_host, listen_port = _host_port(
        os.environ.get("OMNI_WS_LISTEN", ""), "0.0.0.0:8765"
    )
    upstream_host, upstream_port = _host_port(
        os.environ.get("OMNI_WS_UPSTREAM", ""), "127.0.0.1:8766"
    )
    policy_path = os.environ.get("OMNI_WS_POLICY") or (
        os.path.join(auth_dir, "policy.json")
        if os.path.isfile(os.path.join(auth_dir, "policy.json"))
        else None
    )
    return GatewayConfig(
        listen_host=listen_host,
        listen_port=listen_port,
        upstream_host=upstream_host,
        upstream_port=upstream_port,
        tls_dir=os.environ.get("OMNI_WS_TLS_DIR", "/var/lib/omni/tls"),
        auth_dir=auth_dir,
        audit_dir=os.environ.get("OMNI_WS_AUDIT_DIR", "/var/lib/omni/audit"),
        policy_path=policy_path,
        login_timeout=float(os.environ.get("OMNI_WS_LOGIN_TIMEOUT", "10")),
    )


def main() -> int:
    try:
        config = config_from_env()
    except ValueError as exc:
        print(f"omni-ws-gateway: {exc}", file=sys.stderr)
        return 2

    cert = os.path.join(config.tls_dir, "device.crt")
    key = os.path.join(config.tls_dir, "device.key")
    for path in (cert, key):
        if not os.path.isfile(path):
            print(
                f"omni-ws-gateway: missing TLS material {path}; "
                "run `omni-auth init` (the deployer does this automatically)",
                file=sys.stderr,
            )
            return 3
    if not os.access(key, os.R_OK):
        print(
            f"omni-ws-gateway: cannot read {key} (permission denied; "
            "is the unit running as the rosdeck user?)",
            file=sys.stderr,
        )
        return 3

    gateway = Gateway(config)
    try:
        asyncio.run(gateway.serve_forever())
    except KeyboardInterrupt:
        pass
    finally:
        gateway.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
