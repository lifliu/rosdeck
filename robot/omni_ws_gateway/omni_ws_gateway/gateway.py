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
from dataclasses import dataclass, field

from . import cbor_lite, ws_frames
from .auth_store import RateLimiter, UserStore
from .audit import AuditLog
from .policy import Policy, PolicyDecision

__all__ = ["GatewayConfig", "Gateway", "Upstream"]

LOGIN_OPS = ("login",)
MAX_GATE_BUFFER = 1 << 20  # 1 MiB before the login deadline
MAX_MSG_BUFFER = 16 << 20  # 16 MiB accumulated data between parsed frames
STREAM_CLOSE_TIMEOUT = 1.0


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


@dataclass
class ProtocolState:
    """Per-session Foxglove IDs needed for RBAC on binary data frames."""

    services: dict[int, str] = field(default_factory=dict)
    client_channels: dict[int, str] = field(default_factory=dict)
    server_channels: dict[int, str] = field(default_factory=dict)
    subscriptions: dict[int, str] = field(default_factory=dict)
    pending_service_calls: dict[int, tuple[int, str]] = field(default_factory=dict)


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
            protocol_state = ProtocolState()

            to_up = asyncio.create_task(
                self._forward_client_to_upstream(reader, writer, upstream,
                                                  user, role, peer, carryover,
                                                  protocol_state)
            )
            to_app = asyncio.create_task(
                self._forward_upstream_to_client(writer, upstream,
                                                  user, role, peer,
                                                  protocol_state)
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
            # 必须在第一个 await 前同步触发上下游 close。否则 handler 在等待
            # 任一侧关闭时被取消，另一侧 transport 会永远没有机会进入关闭状态。
            upstream_writer = upstream.begin_close() if upstream is not None else None
            _begin_stream_writer_close(writer)
            self.limiter.forget(peer)
            await _wait_stream_writer_closed(writer)
            await _wait_stream_writer_closed(upstream_writer)

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
                                       peer, opcode, payload,
                                       protocol_state: ProtocolState) -> bool:
        """Process one complete client data message; False ends the session."""
        if opcode not in (ws_frames.OP_TEXT, ws_frames.OP_BINARY):
            self.audit.record("protocol_error", user=user, peer=peer,
                              reason="bad opcode in session")
            await _send_close(writer, 1002, "bad opcode")
            await upstream.close()
            return False
        msg = _decode_frame(opcode, payload)
        if msg is None and opcode == ws_frames.OP_BINARY:
            sdk_frame = _decode_sdk_client_frame(payload, protocol_state)
            if sdk_frame is not None:
                op, topic, call_id, service_id = sdk_frame
                decision = self.policy.check_client_op(role, op, topic)
                if (
                    decision.allowed
                    and call_id is not None
                    and call_id in protocol_state.pending_service_calls
                ):
                    decision = PolicyDecision(False, "duplicate service call id")
                self.audit.record(
                    "client_op", user=user, role=role, peer=peer, op=op,
                    topic=topic, allowed=decision.allowed,
                    reason=None if decision.allowed else decision.reason,
                )
                if not decision.allowed:
                    await _send_error(writer, opcode, f"denied: {decision.reason}")
                    return True
                if (
                    call_id is not None
                    and service_id is not None
                    and topic is not None
                ):
                    protocol_state.pending_service_calls[call_id] = (
                        service_id,
                        topic,
                    )
                await upstream.send_frame(opcode, payload)
                return True
        if msg is None:
            self.audit.record("decode_error", user=user, peer=peer)
            await _send_close(writer, 1003, "bad data")
            await upstream.close()
            return False
        op = str(msg.get("op", ""))
        topic = msg.get("topic") or msg.get("service")
        topic = str(topic) if topic else None
        advertised_channels = _client_advertised_channels(msg)
        if op == "advertise" and advertised_channels is not None:
            decisions = [
                self.policy.check_client_op(role, op, channel_topic)
                for _, channel_topic in advertised_channels
            ]
            decision = next(
                (item for item in decisions if not item.allowed),
                PolicyDecision(True),
            )
            topic = ",".join(value for _, value in advertised_channels) or None
        else:
            decision = self.policy.check_client_op(role, op, topic)
        subscriptions = _client_subscriptions(msg, protocol_state)
        if op == "subscribe" and "subscriptions" in msg and subscriptions is None:
            decision = PolicyDecision(False, "invalid or unknown subscription channel")
        self.audit.record(
            "client_op", user=user, role=role, peer=peer, op=op,
            topic=topic, allowed=decision.allowed,
            reason=None if decision.allowed else decision.reason,
        )
        if not decision.allowed:
            await _send_error(writer, opcode, f"denied: {decision.reason}")
            return True
        if op == "advertise" and advertised_channels is not None:
            for channel_id, channel_topic in advertised_channels:
                protocol_state.client_channels[channel_id] = channel_topic
        elif op == "unadvertise":
            for channel_id in msg.get("channelIds", []):
                if isinstance(channel_id, int):
                    protocol_state.client_channels.pop(channel_id, None)
        elif op == "subscribe" and subscriptions is not None:
            for subscription_id, subscription_topic in subscriptions:
                protocol_state.subscriptions[subscription_id] = subscription_topic
        elif op == "unsubscribe":
            for subscription_id in msg.get("subscriptionIds", []):
                if isinstance(subscription_id, int):
                    protocol_state.subscriptions.pop(subscription_id, None)
        await upstream.send_frame(opcode, payload)
        return True

    async def _forward_client_to_upstream(self, reader, writer, upstream,
                                          user, role, peer,
                                          carryover: bytearray | None = None,
                                          protocol_state: ProtocolState | None = None,
                                          ) -> None:
        protocol_state = protocol_state or ProtocolState()
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
                    writer, upstream, user, role, peer, opcode, payload,
                    protocol_state,
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
                await upstream.close()
                return

    async def _forward_upstream_to_client(self, writer, upstream,
                                          user, role, peer,
                                          protocol_state: ProtocolState | None = None
                                          ) -> None:
        protocol_state = protocol_state or ProtocolState()
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
                await upstream.close()
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
                        await upstream.close()
                        return
                    if opcode == ws_frames.OP_PING:
                        await upstream.send_frame(
                            ws_frames.OP_PONG, payload, mask=True
                        )
                    continue  # PONG and the rest: ignore
                msg = _decode_frame(opcode, payload)
                if msg is None:
                    # Foxglove SDK data and service responses are binary envelopes,
                    # not CBOR control objects. Only frames that exactly match a
                    # previously authorized subscription/service call may pass.
                    sdk_frame = None
                    if opcode == ws_frames.OP_BINARY:
                        sdk_frame = _authorize_sdk_server_frame(
                            payload,
                            protocol_state,
                        )
                    if sdk_frame is not None:
                        sdk_op, sdk_topic = sdk_frame
                        decision = self.policy.check_server_op(
                            role,
                            sdk_op,
                            sdk_topic,
                        )
                        if not decision.allowed:
                            self.audit.record(
                                "server_filtered",
                                user=user,
                                role=role,
                                op=sdk_op,
                                topic=sdk_topic,
                                reason=decision.reason,
                            )
                            continue
                        writer.write(ws_frames.build_frame(opcode, payload))
                        await writer.drain()
                        continue
                    self.audit.record("decode_error", user=user, peer=peer,
                                      reason="server frame")
                    continue
                if msg.get("op") == "serviceCallFailure":
                    service_topic = _consume_sdk_service_failure(
                        msg,
                        protocol_state,
                    )
                    if service_topic is None:
                        self.audit.record(
                            "server_filtered",
                            user=user,
                            role=role,
                            op="serviceCallFailure",
                            reason="unknown or mismatched service call",
                        )
                        continue
                _update_server_protocol_state(msg, protocol_state)
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


def _client_advertised_channels(msg: dict) -> list[tuple[int, str]] | None:
    """Extract standard SDK ``advertise.channels`` entries for topic RBAC."""
    if msg.get("op") != "advertise" or "channels" not in msg:
        return None
    channels = msg.get("channels")
    if not isinstance(channels, list):
        return [(-1, "")]
    result: list[tuple[int, str]] = []
    for channel in channels:
        if not isinstance(channel, dict):
            return [(-1, "")]
        channel_id = channel.get("id")
        topic = channel.get("topic")
        if not isinstance(channel_id, int) or channel_id < 0 or not isinstance(topic, str) or not topic:
            return [(-1, "")]
        result.append((channel_id, topic))
    return result


def _client_subscriptions(
    msg: dict,
    protocol_state: ProtocolState,
) -> list[tuple[int, str]] | None:
    """Resolve standard SDK subscription IDs to advertised topic names."""
    if msg.get("op") != "subscribe" or "subscriptions" not in msg:
        return None
    subscriptions = msg.get("subscriptions")
    if not isinstance(subscriptions, list):
        return None
    result: list[tuple[int, str]] = []
    for subscription in subscriptions:
        if not isinstance(subscription, dict):
            return None
        subscription_id = subscription.get("id")
        channel_id = subscription.get("channelId")
        if not isinstance(subscription_id, int) or subscription_id < 0:
            return None
        if not isinstance(channel_id, int) or channel_id < 0:
            return None
        topic = protocol_state.server_channels.get(channel_id)
        if topic is None:
            return None
        result.append((subscription_id, topic))
    return result


def _decode_sdk_client_frame(
    payload: bytes,
    protocol_state: ProtocolState,
) -> tuple[str, str | None, int | None, int | None] | None:
    """Map a Foxglove SDK binary envelope back to its authorized ROS name."""
    if not payload:
        return None
    binary_opcode = payload[0]
    if binary_opcode == 0x01:
        if len(payload) < 5:
            return None
        channel_id = int.from_bytes(payload[1:5], "little")
        return (
            "publish",
            protocol_state.client_channels.get(channel_id),
            None,
            None,
        )
    if binary_opcode == 0x02:
        if len(payload) < 13:
            return None
        service_id = int.from_bytes(payload[1:5], "little")
        call_id = int.from_bytes(payload[5:9], "little")
        encoding_length = int.from_bytes(payload[9:13], "little")
        if encoding_length > len(payload) - 13:
            return None
        return (
            "service_call",
            protocol_state.services.get(service_id),
            call_id,
            service_id,
        )
    return None


def _authorize_sdk_server_frame(
    payload: bytes,
    protocol_state: ProtocolState,
) -> tuple[str, str] | None:
    """Resolve a server binary envelope to prior per-session authority."""
    if not payload:
        return None
    if payload[0] == 0x01:
        if len(payload) < 13:
            return None
        subscription_id = int.from_bytes(payload[1:5], "little")
        topic = protocol_state.subscriptions.get(subscription_id)
        if topic is None:
            return None
        return ("publish", topic)
    if payload[0] == 0x03:
        if len(payload) < 13:
            return None
        service_id = int.from_bytes(payload[1:5], "little")
        call_id = int.from_bytes(payload[5:9], "little")
        encoding_length = int.from_bytes(payload[9:13], "little")
        if encoding_length > len(payload) - 13:
            return None
        pending = protocol_state.pending_service_calls.get(call_id)
        if pending is None or pending[0] != service_id:
            return None
        protocol_state.pending_service_calls.pop(call_id, None)
        return ("service_call", pending[1])
    return None


def _consume_sdk_service_failure(
    msg: dict,
    protocol_state: ProtocolState,
) -> str | None:
    """Consume a text service failure only for the exact pending request."""
    service_id = msg.get("serviceId")
    call_id = msg.get("callId")
    if not isinstance(service_id, int) or not isinstance(call_id, int):
        return None
    pending = protocol_state.pending_service_calls.get(call_id)
    if pending is None or pending[0] != service_id:
        return None
    protocol_state.pending_service_calls.pop(call_id, None)
    return pending[1]


def _update_server_protocol_state(msg: dict, protocol_state: ProtocolState) -> None:
    op = msg.get("op")
    if op == "advertise":
        for channel in msg.get("channels", []):
            if not isinstance(channel, dict):
                continue
            channel_id = channel.get("id")
            topic = channel.get("topic")
            if isinstance(channel_id, int) and channel_id >= 0 and isinstance(topic, str) and topic:
                protocol_state.server_channels[channel_id] = topic
    elif op == "unadvertise":
        removed_topics = set()
        for channel_id in msg.get("channelIds", []):
            if isinstance(channel_id, int):
                topic = protocol_state.server_channels.pop(channel_id, None)
                if topic is not None:
                    removed_topics.add(topic)
        if removed_topics:
            protocol_state.subscriptions = {
                subscription_id: topic
                for subscription_id, topic in protocol_state.subscriptions.items()
                if topic not in removed_topics
            }
    elif op == "advertiseServices":
        for service in msg.get("services", []):
            if not isinstance(service, dict):
                continue
            service_id = service.get("id")
            name = service.get("name")
            if isinstance(service_id, int) and service_id >= 0 and isinstance(name, str) and name:
                protocol_state.services[service_id] = name
    elif op == "unadvertiseServices":
        removed_service_ids = set()
        for service_id in msg.get("serviceIds", []):
            if isinstance(service_id, int):
                protocol_state.services.pop(service_id, None)
                removed_service_ids.add(service_id)
        if removed_service_ids:
            protocol_state.pending_service_calls = {
                call_id: pending
                for call_id, pending in protocol_state.pending_service_calls.items()
                if pending[0] not in removed_service_ids
            }


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


def _abort_stream_writer(writer: asyncio.StreamWriter) -> None:
    """立即中止底层 transport；仅用于正常关闭失败或超时的兜底。"""
    try:
        writer.transport.abort()
    except (ConnectionError, OSError, ssl.SSLError):
        pass


def _begin_stream_writer_close(writer: asyncio.StreamWriter | None) -> None:
    """同步触发关闭，保证后续 task 取消也不会遗漏 transport。"""
    if writer is None:
        return
    try:
        writer.close()
    except (ConnectionError, OSError, ssl.SSLError):
        _abort_stream_writer(writer)


async def _wait_stream_writer_closed(writer: asyncio.StreamWriter | None) -> None:
    """有界等待 TCP/TLS transport 完成关闭。"""
    if writer is None:
        return
    try:
        await asyncio.wait_for(writer.wait_closed(), STREAM_CLOSE_TIMEOUT)
    except asyncio.TimeoutError:
        # 对端可能拒绝完成 TLS close_notify；超时后必须中止底层 transport，
        # 不能让恶意或半开连接无限拖住 Gateway handler。
        _abort_stream_writer(writer)
    except (ConnectionError, OSError, ssl.SSLError):
        # 连接复位属于关闭阶段的正常竞态；abort 确保异常路径同样完成回收。
        _abort_stream_writer(writer)


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

    def begin_close(self) -> asyncio.StreamWriter | None:
        """取走 writer 并同步触发关闭，使重复清理保持幂等。"""
        writer = self.writer
        self.writer = None
        _begin_stream_writer_close(writer)
        return writer

    async def close(self) -> None:
        await _wait_stream_writer_closed(self.begin_close())
