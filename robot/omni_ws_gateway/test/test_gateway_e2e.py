"""Offline end-to-end tests: real TLS gateway on an ephemeral port in front
of a fake loopback foxglove upstream (plain WS). No network, no ROS.

Covers the security contract:
  * plaintext TCP is rejected (TLS is mandatory),
  * subprotocol negotiation: the client's first requested
    Sec-WebSocket-Protocol is echoed in the 101 and the full list is
    passed through to the upstream handshake (legacy clients without the
    header get neither),
  * the first data message MUST be a login (1008 otherwise),
  * bad token / timeout -> close,
  * a full operator session: subscribe forwarded, server data delivered,
    publish forwarded,
  * RBAC: a viewer's publish is denied with an ``error`` op and the
    upstream never sees it,
  * CBOR binary login is accepted,
  * upstream down -> close 1011.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_ws_gateway import cbor_lite, ws_frames  # noqa: E402
from omni_ws_gateway.gateway import Gateway, GatewayConfig  # noqa: E402

HAVE_OPENSSL = shutil.which("openssl") is not None


# -- TLS material -------------------------------------------------------------


def make_cert(directory: str) -> None:
    key = os.path.join(directory, "device.key")
    crt = os.path.join(directory, "device.crt")
    subprocess.run(
        ["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout",
         "-out", key],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["openssl", "req", "-new", "-x509", "-key", key, "-sha256",
         "-days", "1", "-subj", "/CN=gateway-test",
         "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
         "-out", crt],
        check=True, capture_output=True,
    )


# -- fake foxglove upstream ----------------------------------------------------


class FakeFoxglove:
    """Plain-WS server that records every frame the gateway forwards,
    plus each handshake request head it receives."""

    def __init__(self):
        self.frames: list[tuple[int, bytes]] = []
        self.request_heads: list[bytes] = []
        self._writer = None
        self.server = None

    async def _handle(self, reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.TimeoutError,
                ConnectionError):
            return
        self.request_heads.append(head)
        writer.write(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
        )
        await writer.drain()
        self._writer = writer
        buf = bytearray()
        while True:
            try:
                data = await reader.read(65536)
            except (ConnectionError, OSError):
                return
            if not data:
                return
            buf.extend(data)
            while True:
                frame = ws_frames.read_frame(buf)
                if frame is None:
                    break
                _fin, opcode, payload = frame
                self.frames.append((opcode, payload))
                if opcode == ws_frames.OP_CLOSE:
                    return

    async def start(self) -> int:
        self.server = await asyncio.start_server(
            self._handle, "127.0.0.1", 0
        )
        return self.server.sockets[0].getsockname()[1]

    async def stop(self):
        if self._writer is not None:
            self._writer.close()
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def send_json(self, obj):
        payload = json.dumps(obj).encode()
        self._writer.write(
            ws_frames.build_frame(ws_frames.OP_TEXT, payload)
        )
        await self._writer.drain()

    async def send_cbor(self, obj):
        payload = cbor_lite.encode(obj)
        self._writer.write(
            ws_frames.build_frame(ws_frames.OP_BINARY, payload)
        )
        await self._writer.drain()

    async def wait_for(self, predicate, timeout: float = 5.0) -> bool:
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            if any(predicate(op, payload) for op, payload in self.frames):
                return True
            await asyncio.sleep(0.01)
        return False


# -- TLS WS client -------------------------------------------------------------


class WsClient:
    DEFAULT_PROTOCOLS = ["foxglove.sdk.v1", "foxglove.websocket.v1"]

    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.buf = bytearray()
        self.assembler = ws_frames.MessageAssembler()
        self.headers: dict[str, str] = {}

    @classmethod
    async def connect(cls, host: str, port: int, timeout: float = 5.0,
                      protocols: list[str] | None = None):
        """``protocols=None`` sends DEFAULT_PROTOCOLS; ``[]`` sends no
        Sec-WebSocket-Protocol header at all (legacy client)."""
        import ssl

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=ctx), timeout
        )
        client = cls(reader, writer)
        if protocols is None:
            protocols = cls.DEFAULT_PROTOCOLS
        await client._upgrade(protocols)
        return client

    async def _upgrade(self, protocols: list[str]):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        proto_line = (
            f"Sec-WebSocket-Protocol: {', '.join(protocols)}\r\n"
            if protocols else "")
        self.writer.write(
            (f"GET / HTTP/1.1\r\n"
             f"Host: 127.0.0.1\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             f"Sec-WebSocket-Key: {key}\r\n"
             "Sec-WebSocket-Version: 13\r\n"
             f"{proto_line}"
             "\r\n").encode("ascii")
        )
        await self.writer.drain()
        head = await asyncio.wait_for(self.reader.readuntil(b"\r\n\r\n"), 5.0)
        status = head.split(b"\r\n", 1)[0]
        if b"101" not in status:
            raise ConnectionError(f"no 101 from gateway: {status!r}")
        for line in head.decode("latin-1").split("\r\n")[1:]:
            if ":" in line:
                k, _, v = line.partition(":")
                self.headers[k.strip().lower()] = v.strip()
        if protocols:
            echoed = self.headers.get("sec-websocket-protocol")
            if echoed != protocols[0]:
                raise AssertionError(
                    f"gateway did not echo {protocols[0]!r}, got {echoed!r}"
                )

    async def send(self, opcode: int, payload: bytes):
        key = ws_frames.random_key()
        self.writer.write(
            ws_frames.build_frame(opcode, payload, mask_key=key)
        )
        await self.writer.drain()

    async def send_json(self, obj):
        await self.send(ws_frames.OP_TEXT, json.dumps(obj).encode())

    async def send_cbor(self, obj):
        await self.send(ws_frames.OP_BINARY, cbor_lite.encode(obj))

    async def recv(self, timeout: float = 5.0) -> tuple[int, bytes]:
        while True:
            frame = ws_frames.read_frame(self.buf)
            if frame is None:
                data = await asyncio.wait_for(
                    self.reader.read(65536), timeout
                )
                if not data:
                    raise ConnectionError("gateway closed the connection")
                self.buf.extend(data)
                continue
            fin, opcode, payload = frame
            result = self.assembler.feed(fin, opcode, payload)
            if result is None:
                continue
            _kind, opcode, payload = result
            return opcode, payload

    async def close(self):
        try:
            await self.send(
                ws_frames.OP_CLOSE, (1000).to_bytes(2, "big")
            )
        except (ConnectionError, OSError):
            pass
        self.writer.close()


def close_status(payload: bytes):
    return int.from_bytes(payload[:2], "big") if len(payload) >= 2 else None


# -- test case -----------------------------------------------------------------


@unittest.skipUnless(HAVE_OPENSSL, "openssl not available")
class GatewayE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tls = tempfile.TemporaryDirectory()
        make_cert(cls._tls.name)

    @classmethod
    def tearDownClass(cls):
        cls._tls.cleanup()

    def _scenario(self, fn):
        return asyncio.run(asyncio.wait_for(fn(), 20.0))

    def _gateway(self, tmp: str, upstream_port: int, **kw):
        cfg = GatewayConfig(
            listen_host="127.0.0.1",
            listen_port=0,
            upstream_host="127.0.0.1",
            upstream_port=upstream_port,
            tls_dir=self._tls.name,
            auth_dir=os.path.join(tmp, "auth"),
            audit_dir=os.path.join(tmp, "audit"),
            **kw,
        )
        os.makedirs(cfg.auth_dir, exist_ok=True)
        return Gateway(cfg)

    def _audit_events(self, audit_dir: str) -> list[str]:
        lines = []
        for name in os.listdir(audit_dir):
            if not name.endswith(".jsonl"):
                continue
            with open(os.path.join(audit_dir, name), encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if raw:
                        lines.append(json.loads(raw)["event"])
        return lines

    async def _wait_upstream(self, fake, count: int, timeout: float = 5.0):
        """Wait until the gateway has opened ``count`` upstream
        connections (one per successful login)."""
        deadline = asyncio.get_event_loop().time() + timeout
        while len(fake.request_heads) < count:
            if asyncio.get_event_loop().time() > deadline:
                break
            await asyncio.sleep(0.01)
        self.assertGreaterEqual(len(fake.request_heads), count)

    # -- scenarios ----------------------------------------------------------

    def test_plain_tcp_rejected(self):
        async def run():

            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port)
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                # raw TCP, no TLS: the handshake cannot complete
                reader, writer = await asyncio.open_connection(
                    "127.0.0.1", port
                )
                key = base64.b64encode(os.urandom(16)).decode("ascii")
                writer.write(
                    (f"GET / HTTP/1.1\r\nHost: x\r\n"
                     "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                     f"Sec-WebSocket-Key: {key}\r\n"
                     "Sec-WebSocket-Version: 13\r\n\r\n").encode()
                )
                await writer.drain()
                data = b""
                try:
                    while len(data) < 2048:
                        chunk = await asyncio.wait_for(
                            reader.read(4096), 3.0
                        )
                        if not chunk:
                            break
                        data += chunk
                except (asyncio.TimeoutError, ConnectionError, OSError):
                    pass
                writer.close()
                self.assertNotIn(b"101", data)
                self.assertNotIn(b"Switching Protocols", data)
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_subprotocol_negotiation(self):
        async def run():
            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port)
            token = gw.users.add_user("alice", "operator")
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]

                # 1. A client that requests subprotocols: the gateway
                #    echoes the first one (checked inside WsClient) and
                #    passes the full list through to the upstream.
                client = await WsClient.connect("127.0.0.1", port)
                self.assertEqual(
                    "foxglove.sdk.v1",
                    client.headers.get("sec-websocket-protocol"))
                await client.send_json(
                    {"op": "login", "user": "alice", "token": token}
                )
                await self._wait_upstream(fake, 1)
                head = fake.request_heads[0].decode("latin-1")
                self.assertIn(
                    "Sec-WebSocket-Protocol: "
                    "foxglove.sdk.v1, foxglove.websocket.v1", head,
                )
                await client.close()
                client = None

                # 2. A legacy client without the header: no echo back,
                #    none forwarded upstream either.
                client = await WsClient.connect(
                    "127.0.0.1", port, protocols=[])
                self.assertNotIn("sec-websocket-protocol", client.headers)
                await client.send_json(
                    {"op": "login", "user": "alice", "token": token}
                )
                await self._wait_upstream(fake, 2)
                head = fake.request_heads[1].decode("latin-1")
                self.assertNotIn("Sec-WebSocket-Protocol", head)
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_first_message_must_be_login(self):
        async def run():
            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port)
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                client = await WsClient.connect("127.0.0.1", port)
                await client.send_json(
                    {"op": "subscribe", "topic": "/omni/robot_state"}
                )
                opcode, payload = await client.recv()
                self.assertEqual(ws_frames.OP_CLOSE, opcode)
                self.assertEqual(1008, close_status(payload))
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_bad_token_rejected(self):
        async def run():
            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port)
            gw.users.add_user("alice", "operator")
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                client = await WsClient.connect("127.0.0.1", port)
                await client.send_json(
                    {"op": "login", "user": "alice",
                     "token": "omni_wrong"}
                )
                opcode, payload = await client.recv()
                self.assertEqual(ws_frames.OP_CLOSE, opcode)
                self.assertEqual(1008, close_status(payload))
                self.assertEqual([], fake.frames)  # nothing forwarded
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_login_timeout(self):
        async def run():
            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port, login_timeout=1.0)
            gw.users.add_user("alice", "operator")
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                client = await WsClient.connect("127.0.0.1", port)
                # send nothing; the gate must time out and close
                opcode, payload = await client.recv(timeout=8.0)
                self.assertEqual(ws_frames.OP_CLOSE, opcode)
                self.assertEqual(1008, close_status(payload))
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_full_operator_session(self):
        async def run():
            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port)
            token = gw.users.add_user("alice", "operator")
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                client = await WsClient.connect("127.0.0.1", port)
                # login and a pipelined subscribe in the same burst --
                # exercises the carryover path
                await client.send_json(
                    {"op": "login", "user": "alice", "token": token}
                )
                await client.send_json(
                    {"op": "subscribe", "topic": "/omni/robot_state",
                     "type": "std_msgs/String", "encoding": "json"}
                )
                ok = await fake.wait_for(
                    lambda op, p: op == ws_frames.OP_TEXT
                    and json.loads(p).get("op") == "subscribe"
                )
                self.assertTrue(ok, f"subscribe not forwarded: {fake.frames}")

                # server -> client: advertise arrives as CBOR binary
                await fake.send_cbor(
                    {"op": "advertise", "topic": "/omni/robot_state",
                     "type": "std_msgs/String", "encoding": "json"}
                )
                opcode, payload = await client.recv()
                self.assertEqual(ws_frames.OP_BINARY, opcode)
                msg = cbor_lite.decode(payload)
                self.assertEqual("advertise", msg["op"])
                self.assertEqual("/omni/robot_state", msg["topic"])

                # operator publishes a teleop command
                await client.send_json(
                    {"op": "publish", "topic": "/omni/cmd_vel/teleop",
                     "type": "geometry_msgs/TwistStamped",
                     "encoding": "json",
                     "data": {"linear": {"x": 0.5}}}
                )
                ok = await fake.wait_for(
                    lambda op, p: op == ws_frames.OP_TEXT
                    and json.loads(p).get("op") == "publish"
                    and json.loads(p).get("topic") == "/omni/cmd_vel/teleop"
                )
                self.assertTrue(ok, "publish not forwarded")

                # clean shutdown: client close is relayed upstream
                await client.close()
                ok = await fake.wait_for(
                    lambda op, p: op == ws_frames.OP_CLOSE
                )
                self.assertTrue(ok, "close not relayed upstream")

                events = self._audit_events(os.path.join(tmp, "audit"))
                for wanted in ("login_ok", "session_start", "client_op"):
                    self.assertIn(wanted, events)
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_viewer_publish_denied(self):
        async def run():
            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port)
            token = gw.users.add_user("bob", "viewer")
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                client = await WsClient.connect("127.0.0.1", port)
                await client.send_json(
                    {"op": "login", "user": "bob", "token": token}
                )
                # viewing is fine
                await client.send_json(
                    {"op": "subscribe", "topic": "/omni/robot_state"}
                )
                # but publishing is not
                await client.send_json(
                    {"op": "publish", "topic": "/omni/cmd_vel/teleop",
                     "data": {"x": 1}}
                )
                opcode, payload = await client.recv()
                self.assertEqual(ws_frames.OP_TEXT, opcode)
                err = json.loads(payload)
                self.assertEqual("error", err["op"])
                self.assertIn("denied", err["error"])

                # upstream saw the subscribe, never the publish
                ops = []
                for op, p in fake.frames:
                    if op == ws_frames.OP_TEXT:
                        ops.append(json.loads(p).get("op"))
                self.assertIn("subscribe", ops)
                self.assertNotIn("publish", ops)

                events = self._audit_events(os.path.join(tmp, "audit"))
                self.assertIn("client_op", events)
                self.assertIn("login_ok", events)
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_cbor_login(self):
        async def run():
            tmp = tempfile.mkdtemp()
            fake = FakeFoxglove()
            up_port = await fake.start()
            gw = self._gateway(tmp, up_port)
            token = gw.users.add_user("carol", "operator")
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                client = await WsClient.connect("127.0.0.1", port)
                await client.send_cbor(
                    {"op": "login", "user": "carol", "token": token}
                )
                await client.send_cbor(
                    {"op": "subscribe", "topic": "/omni/robot_state"}
                )
                ok = await fake.wait_for(
                    lambda op, p: op == ws_frames.OP_BINARY
                    and cbor_lite.decode(p).get("op") == "subscribe"
                )
                self.assertTrue(ok, f"CBOR subscribe not forwarded: "
                                    f"{fake.frames}")
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()
                await fake.stop()

        self._scenario(run)

    def test_upstream_down(self):
        async def run():
            import socket as _socket

            tmp = tempfile.mkdtemp()
            # a port that is not listening
            probe = _socket.socket()
            probe.bind(("127.0.0.1", 0))
            dead_port = probe.getsockname()[1]
            probe.close()

            gw = self._gateway(tmp, dead_port)
            token = gw.users.add_user("alice", "operator")
            server = await gw.start()
            client = None
            try:
                port = server.sockets[0].getsockname()[1]
                client = await WsClient.connect("127.0.0.1", port)
                await client.send_json(
                    {"op": "login", "user": "alice", "token": token}
                )
                opcode, payload = await client.recv()
                self.assertEqual(ws_frames.OP_CLOSE, opcode)
                self.assertEqual(1011, close_status(payload))
            finally:
                if client is not None:
                    client.writer.close()
                server.close()
                await server.wait_closed()

        self._scenario(run)


if __name__ == "__main__":
    unittest.main()
