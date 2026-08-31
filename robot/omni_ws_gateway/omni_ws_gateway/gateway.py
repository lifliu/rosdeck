"""The gateway itself: TLS WebSocket server in front of foxglove_bridge.

Per-connection lifecycle:
  1. TLS handshake (device certificate).
  2. HTTP/1.1 -> WebSocket upgrade: the client's first requested
     subprotocol is echoed back (RFC 6455), and the full requested list
     is passed through to the upstream handshake so client and bridge
     agree on the framing version.
  3. Login gate: the first data message MUST be ``{"op": "login",
     "user": ..., "token": ...}`` (JSON text or CBOR binary), otherwise
     the connection is closed with 1008.
  4. Forwarding: an upstream WebSocket connection to foxglove_bridge
     (loopback) is opened; frames flow both ways, each inspected with
     the RBAC policy and written to the audit log. Allowed frames are
     forwarded byte-for-byte (the gateway never re-serializes).

Fail-closed rules: undecodable frames close the connection (1003);
denied frames are dropped with an ``error`` op sent back in the same
serialization as the offending frame; audit write failures never
interrupt the data path.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import ssl
from dataclasses import dataclass

from . import cbor_lite, ws_frames
from .auth_store import RateLimiter, UserStore
from .audit import AuditLog
from .policy import Policy

__all__ = ["GatewayConfig", "Gateway", "Upstream"]

LOGIN_OPS = ("login",)
MAX_GATE_BUFFER = 1 << 20  # 1 MiB before the login deadline
MAX_MSG_BUFFER = 16 << 20  # 16 MiB accumulated data between parsed frames


@dataclass(frozen=True)
class GatewayConfig:
    listen_host: str = "0.0.0.0"
    listen_port: int = 8765
    upstream_host: str = "127.0.0.1"
    upstream_port: int = 8766
    tls_dir: str = "/var/lib/omni/tls"
    auth_dir: str = "/var/lib/omni/auth"
    audit_dir: str = "/var/lib/omni/audit"
    policy_path: str | None = None
    login_timeout: float = 10.0


class Gateway:
    def __init__(self, config: GatewayConfig):
        self.config = config
        self.users = UserStore(os.path.join(config.auth_dir, "users.json"))
        self.policy = Policy.load(config.policy_path)
        self.audit = AuditLog(config.audit_dir)
        self.limiter = RateLimiter()

    # -- TLS / server lifecycle ------------------------------------------

    def _tls_context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(
            os.path.join(self.config.tls_dir, "device.crt"),
            os.path.join(self.config.tls_dir, "device.key"),
        )
        return ctx

    async def start(self) -> asyncio.Server:
        """Bind the listener; returns the server (tests use port 0)."""
        ctx = self._tls_context()
        server = await asyncio.start_server(
            self._handle_client,
            self.config.listen_host,
            self.config.listen_port,
            ssl=ctx,
        )
        sock = server.sockets[0]
        self.audit.record("gateway_start", detail={
            "listen": f"{sock.getsockname()[0]}:{sock.getsockname()[1]}",
            "upstream": f"{self.config.upstream_host}:{self.config.upstream_port}",
        })
        return server

    async def serve_forever(self) -> None:
        server = await self.start()
        async with server:
            await server.serve_forever()

    # -- per-connection ---------------------------------------------------

    async def _handle_client(self, reader: asyncio.StreamReader,
                             writer: asyncio.StreamWriter) -> None:
        peer = _peer_str(writer.get_extra_info("peername"))
        upstream: Upstream | None = None
        try:
            protocols = await _upgrade_server(reader, writer)
            if protocols is None:
                self.audit.record("upgrade_rejected", peer=peer)
                return
            self.audit.record("tls_connect", peer=peer)
            authed = await self._login_gate(reader, writer, peer)
            if authed is None:
                return
            user, role, carryover = authed
            self.audit.record("login_ok", user=user, role=role, peer=peer)

            upstream = Upstream()
            try:
                await upstream.connect(
                    self.config.upstream_host, self.config.upstream_port,
                    protocols,
                )
            except Exception as exc:  # noqa: BLE001 - report and close
                self.audit.record(
                    "upstream_connect_failed", user=user, peer=peer,
                    reason=str(exc)[:200],
                )
                await _send_close(writer, 1011, "upstream unavailable")
                return
            self.audit.record("session_start", user=user, role=role, peer=peer)

            to_up = asyncio.create_task(
                self._forward_client_to_upstream(reader, writer, upstream,
                                                  user, role, peer, carryover)
            )
            to_app = asyncio.create_task(
                self._forward_upstream_to_client(writer, upstream,
                                                  user, role, peer)
            )
            done, pending = await asyncio.wait(
                {to_up, to_app}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in pending:
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            for task in done:
                exc = task.exception()
                if exc is not None and not isinstance(
                    exc, (asyncio.CancelledError, ConnectionError)
                ):
                    self.audit.record(
                        "forward_error", user=user, peer=peer,
                        reason=str(exc)[:200],
                    )
        except ws_frames.WsError as exc:
            self.audit.record("protocol_error", peer=peer, reason=str(exc)[:200])
            await _send_close(writer, 1002, "protocol error")
        except asyncio.IncompleteReadError:
            pass  # peer hung up mid-header
        except ConnectionError:
            pass
        finally:
            if upstream is not None:
                upstream.close()
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
            self.limiter.forget(peer)

    # -- login gate ---------------------------------------------------------

    async def _login_gate(self, reader, writer, peer: str):
        """Wait for the first data message; it must be a valid login."""
        deadline = asyncio.get_event_loop().time() + self.config.login_timeout
        buf = bytearray()
        login_asm = ws_frames.MessageAssembler()
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                self.audit.record("login_timeout", peer=peer)
                await _send_close(writer, 1008, "login timeout")
                return None
            try:
                data = await asyncio.wait_for(reader.read(65536), remaining)
            except asyncio.TimeoutError:
                self.audit.record("login_timeout", peer=peer)
                await _send_close(writer, 1008, "login timeout")
                return None
            if not data:
                self.audit.record("login_dropped", peer=peer,
                                  reason="peer closed before login")
                return None
            buf.extend(data)
            if len(buf) > MAX_GATE_BUFFER:
                self.audit.record("login_denied", peer=peer,
                                  reason="gate buffer overflow")
                await _send_close(writer, 1009, "message too big")
                return None
            frame = ws_frames.read_frame(buf)
            if frame is None:
                continue
            fin, opcode, payload = frame
            result = login_asm.feed(fin, opcode, payload)
            if result is None:
                continue  # still assembling the login message
            kind, opcode, payload = result
            if kind == "control":
                if opcode == ws_frames.OP_PING:
                    writer.write(ws_frames.build_frame(
                        ws_frames.OP_PONG, payload))
                    await writer.drain()
                    continue
                if opcode == ws_frames.OP_CLOSE:
                    return None
                continue  # stray PONG before login: ignore
            return await self._try_login(writer, peer, opcode, payload, buf)

    async def _try_login(self, writer, peer, opcode, payload, buf: bytearray):
        """Validate the login frame. On success returns
        ``(user, role, carryover)`` where ``carryover`` is any frame data
        already buffered behind the login frame (pipelined by the client);
        the forwarding loop must process it before reading more bytes."""
        msg = _decode_frame(opcode, payload)
        if not msg or msg.get("op") not in LOGIN_OPS:
            self.audit.record("login_denied", peer=peer,
                              reason="first message is not login")
            await _send_close(writer, 1008, "login required")
            return None
        if not self.limiter.allow(peer):
            self.audit.record("login_denied", peer=peer, reason="rate limited")
            await _send_close(writer, 4403, "rate limited")
            return None
        result = self.users.verify(str(msg.get("token", "")))
        if not result.ok or result.user is None:
            self.limiter.record_failure(peer)
            self.audit.record("login_fail", peer=peer, reason=result.reason)
            await _send_close(writer, 1008, "authentication failed")
            return None
        self.limiter.record_success(peer)
        return (result.user.name, result.user.role, buf)

    # -- forwarding ---------------------------------------------------------

    async def _dispatch_client_control(self, writer, upstream, opcode,
                                     payload) -> bool:
        """Handle one client control frame; False when the session ends."""
        if opcode == ws_frames.OP_CLOSE:
            status = 1000
            if len(payload) >= 2:
                status = int.from_bytes(payload[:2], "big")
            await _upstream_send_close(upstream, status)
            await _send_close(writer, status, "")  # echo, then end
            return False
        if opcode == ws_frames.OP_PING:
            writer.write(ws_frames.build_frame(ws_frames.OP_PONG, payload))
            await writer.drain()
            return True
        return True  # PONG: nothing to do

    async def _dispatch_client_message(self, writer, upstream, user, role,
                                       peer, opcode, payload) -> bool:
        """Process one complete client data message; False ends the session."""
        if opcode not in (ws_frames.OP_TEXT, ws_frames.OP_BINARY):
            self.audit.record("protocol_error", user=user, peer=peer,
                              reason="bad opcode in session")
            await _send_close(writer, 1002, "bad opcode")
            upstream.close()
            return False
        msg = _decode_frame(opcode, payload)
        if msg is None:
            self.audit.record("decode_error", user=user, peer=peer)
            await _send_close(writer, 1003, "bad data")
            upstream.close()
            return False
        op = str(msg.get("op", ""))
        topic = msg.get("topic") or msg.get("service")
        topic = str(topic) if topic else None
        decision = self.policy.check_client_op(role, op, topic)
        self.audit.record(
            "client_op", user=user, role=role, peer=peer, op=op,
            topic=topic, allowed=decision.allowed,
            reason=None if decision.allowed else decision.reason,
        )
        if not decision.allowed:
            await _send_error(writer, opcode, f"denied: {decision.reason}")
            return True
        await upstream.send_frame(opcode, payload)
        return True

    async def _forward_client_to_upstream(self, reader, writer, upstream,
                                          user, role, peer,
                                          carryover: bytearray | None = None
                                          ) -> None:
        buf = bytearray(carryover) if carryover else bytearray()
        asm = ws_frames.MessageAssembler()
        while True:
            while True:
                frame = ws_frames.read_frame(buf)
                if frame is None:
                    break
                fin, opcode, payload = frame
                result = asm.feed(fin, opcode, payload)
                if result is None:
                    continue
                kind, opcode, payload = result
                if kind == "control":
                    if not await self._dispatch_client_control(
                        writer, upstream, opcode, payload
                    ):
                        return
                    continue
                if not await self._dispatch_client_message(
                    writer, upstream, user, role, peer, opcode, payload
                ):
                    return
            data = await reader.read(65536)
            if not data:
                await _upstream_send_close(upstream, 1000)
                return
            buf.extend(data)
            if len(buf) > MAX_MSG_BUFFER:
                self.audit.record("frame_oversized", user=user, peer=peer)
                await _send_close(writer, 1009, "message too big")
                upstream.close()
                return

    async def _forward_upstream_to_client(self, writer, upstream,
                                          user, role, peer) -> None:
        buf = bytearray()
        asm = ws_frames.MessageAssembler()
        while True:
            data = await upstream.reader.read(65536)
            if not data:
                await _send_close(writer, 1006, "upstream closed")
                return
            buf.extend(data)
            if len(buf) > MAX_MSG_BUFFER:
                self.audit.record("frame_oversized", user=user, peer=peer)
                await _send_close(writer, 1009, "message too big")
                upstream.close()
                return
            while True:
                frame = ws_frames.read_frame(buf)
                if frame is None:
                    break
                fin, opcode, payload = frame
                result = asm.feed(fin, opcode, payload)
                if result is None:
                    continue
                kind, opcode, payload = result
                if kind == "control":
                    if opcode == ws_frames.OP_CLOSE:
                        await _send_close(writer, 1000, "upstream closed")
                        upstream.close()
                        return
                    if opcode == ws_frames.OP_PING:
                        await upstream.send_frame(
                            ws_frames.OP_PONG, payload, mask=True
                        )
                    continue  # PONG and the rest: ignore
                msg = _decode_frame(opcode, payload)
                if msg is None:
                    # Undecodable server data: do not forward it.
                    self.audit.record("decode_error", user=user, peer=peer,
                                      reason="server frame")
                    continue
                op = str(msg.get("op", ""))
                topic = msg.get("topic") or msg.get("service")
                topic = str(topic) if topic else None
                decision = self.policy.check_server_op(role, op, topic)
                if not decision.allowed:
                    self.audit.record(
                        "server_filtered", user=user, role=role, op=op,
                        topic=topic, reason=decision.reason,
                    )
                    continue
                writer.write(ws_frames.build_frame(opcode, payload))
                await writer.drain()

    # -- housekeeping ---------------------------------------------------------

    def cleanup(self) -> None:
        self.audit.record("gateway_stop")


# -- module-level helpers -----------------------------------------------------


def _peer_str(peername) -> str:
    if not peername:
        return "?"
    try:
        return f"{peername[0]}:{peername[1]}"
    except Exception:  # noqa: BLE001
        return str(peername)


def _decode_frame(opcode: int, payload: bytes):
    """Decode a data frame for policy inspection; None on failure."""
    try:
        if opcode == ws_frames.OP_TEXT:
            msg = json.loads(payload.decode("utf-8"))
        else:
            msg = cbor_lite.decode(payload)
        if not isinstance(msg, dict):
            return None
        return msg
    except (ValueError, UnicodeDecodeError, cbor_lite.CborError):
        return None


def _parse_subprotocols(header: str) -> list[str]:
    """Parse a ``Sec-WebSocket-Protocol`` header value into a list of
    valid subprotocol tokens (printable ASCII, no whitespace)."""
    tokens = []
    for part in header.split(","):
        token = part.strip()
        if token and all(0x21 <= ord(c) <= 0x7e for c in token):
            tokens.append(token)
    return tokens


async def _upgrade_server(reader: asyncio.StreamReader,
                          writer: asyncio.StreamWriter) -> list[str] | None:
    """Read the HTTP upgrade request and answer 101.

    Returns the client's requested subprotocols (an empty list when the
    client sent no ``Sec-WebSocket-Protocol`` header); ``None`` means the
    upgrade was rejected. The first requested subprotocol is echoed back
    in the 101 response (RFC 6455 section 4.1).
    """
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10.0)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError):
        return None
    try:
        head = raw.decode("latin-1")
    except UnicodeDecodeError:
        return None
    lines = head.split("\r\n")
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()
    if headers.get("upgrade", "").lower() != "websocket":
        return None
    key = headers.get("sec-websocket-key", "")
    if not key:
        return None
    protocols = _parse_subprotocols(
        headers.get("sec-websocket-protocol", ""))
    accept = ws_frames.accept_key(key)
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
    )
    if protocols:
        # Echo the client's first choice; it lists protocols by
        # preference, so this is the version both ends will speak.
        response += f"Sec-WebSocket-Protocol: {protocols[0]}\r\n"
    response += "\r\n"
    writer.write(response.encode("ascii"))
    await writer.drain()
    return protocols


async def _send_close(writer: asyncio.StreamWriter, status: int,
                      reason: str = "") -> None:
    try:
        writer.write(ws_frames.close_frame(status, reason))
        await writer.drain()
        # linger briefly for the peer's close acknowledgment
        await asyncio.sleep(0.1)
    except (ConnectionError, OSError):
        pass


async def _upstream_send_close(upstream: Upstream, status: int) -> None:
    try:
        await upstream.send_close(status)
    except (ConnectionError, OSError):
        pass


async def _send_error(writer: asyncio.StreamWriter, offending_opcode: int,
                      message: str) -> None:
    """Send a protocol ``error`` op back in the same serialization as the
    offending frame (JSON text or CBOR binary)."""
    try:
        if offending_opcode == ws_frames.OP_TEXT:
            payload = json.dumps({"op": "error", "error": message}).encode()
            frame = ws_frames.build_frame(ws_frames.OP_TEXT, payload)
        else:
            payload = cbor_lite.encode({"op": "error", "error": message})
            frame = ws_frames.build_frame(ws_frames.OP_BINARY, payload)
        writer.write(frame)
        await writer.drain()
    except (ConnectionError, OSError):
        pass


class Upstream:
    """WebSocket *client* toward the loopback foxglove_bridge."""

    def __init__(self) -> None:
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.buf = bytearray()

    async def connect(self, host: str, port: int,
                      protocols: list[str] | None = None) -> None:
        self.reader, self.writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), 10.0
        )
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        proto_line = (
            f"Sec-WebSocket-Protocol: {', '.join(protocols)}\r\n"
            if protocols else ""
        )
        request = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"{proto_line}"
            "\r\n"
        )
        self.writer.write(request.encode("ascii"))
        await self.writer.drain()
        head = await asyncio.wait_for(self.reader.readuntil(b"\r\n\r\n"), 10.0)
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1")
        if "101" not in status_line:
            raise ConnectionError(f"upstream refused WS upgrade: {status_line}")

    async def send_frame(self, opcode: int, payload: bytes,
                         mask: bool = True) -> None:
        key = ws_frames.random_key() if mask else None
        self.writer.write(ws_frames.build_frame(opcode, payload, mask_key=key))
        await self.writer.drain()

    async def send_close(self, status: int) -> None:
        await self.send_frame(ws_frames.OP_CLOSE,
                              status.to_bytes(2, "big"), mask=True)

    def close(self) -> None:
        if self.writer is not None:
            try:
                self.writer.close()
            except Exception:  # noqa: BLE001
                pass
            self.writer = None
