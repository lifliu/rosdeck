"""Minimal RFC 6455 WebSocket frame codec (handshake + frames).

Used in both directions by the gateway:
  * server side (app -> gateway): client frames MUST be masked; we unmask.
  * client side (gateway -> foxglove_bridge): our frames MUST be masked,
    so we pass a random 4-byte key to :func:`build_frame`.

:func:`read_frame` parses single frames; a per-direction
:class:`MessageAssembler` reassembles fragmented data messages, with
control frames passing through interleaved (RFC 6455 5.4), so a
fragmented data message cannot wedge the connection.
"""

from __future__ import annotations

import base64
import hashlib
import os
import struct

__all__ = [
    "WS_MAGIC",
    "OP_TEXT",
    "OP_BINARY",
    "OP_CLOSE",
    "OP_PING",
    "OP_PONG",
    "WsError",
    "MessageAssembler",
    "accept_key",
    "build_frame",
    "random_key",
    "read_frame",
    "close_frame",
]

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WsError(ValueError):
    """Protocol violation while parsing or building frames."""


def accept_key(client_key: str) -> str:
    """Compute Sec-WebSocket-Accept from the client's Sec-WebSocket-Key."""
    digest = hashlib.sha1((client_key + WS_MAGIC).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def random_key() -> bytes:
    """Random 4-byte frame masking key (client -> server direction)."""
    return os.urandom(4)


def _xor(payload: bytes, key: bytes) -> bytes:
    if not key or len(key) != 4:
        raise WsError("mask key must be 4 bytes")
    return bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def build_frame(opcode: int, payload: bytes, mask_key: bytes | None = None) -> bytes:
    """Build one complete (unfragmented) WebSocket frame.

    Pass a 4-byte ``mask_key`` to produce a masked frame (required for
    client -> server frames); leave it ``None`` for unmasked frames
    (server -> client).
    """
    header = bytearray([0x80 | (opcode & 0x0F)])  # FIN=1
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 0x10000:
        header.append(126)
        header.extend(struct.pack(">H", length))
    else:
        header.append(127)
        header.extend(struct.pack(">Q", length))
    if mask_key is not None:
        header[1] |= 0x80  # mask bit lives in the length byte
        header.extend(mask_key)
        return bytes(header) + _xor(payload, mask_key)
    return bytes(header) + payload


def close_frame(status: int, reason: str = "") -> bytes:
    """Build an unmasked close frame (server -> client / tests)."""
    payload = struct.pack(">H", status) + reason.encode("utf-8")[:120]
    return build_frame(OP_CLOSE, payload)


def read_frame(buf: bytearray) -> tuple[bool, int, bytes] | None:
    """Parse exactly one frame from ``buf`` (consumed in place).

    Returns ``(fin, opcode, payload)`` for one frame, or ``None`` when
    the buffer does not yet hold a complete frame. One application
    message may span several frames; feed the frames through a
    :class:`MessageAssembler` to reassemble them.
    """
    if len(buf) < 2:
        return None
    first, second = buf[0], buf[1]
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    if opcode not in (OP_CONTINUATION, OP_TEXT, OP_BINARY,
                      OP_CLOSE, OP_PING, OP_PONG):
        raise WsError(f"reserved or undefined opcode {opcode:#x}")
    masked = bool(second & 0x80)
    length = second & 0x7F
    pos = 2
    if length == 126:
        if len(buf) < pos + 2:
            return None
        (length,) = struct.unpack_from(">H", buf, pos)
        pos += 2
    elif length == 127:
        if len(buf) < pos + 8:
            return None
        (length,) = struct.unpack_from(">Q", buf, pos)
        pos += 8
        if length > 0x40000000:
            raise WsError("frame length implausible")
    key = b""
    if masked:
        if len(buf) < pos + 4:
            return None
        key = bytes(buf[pos : pos + 4])
        pos += 4
    if len(buf) < pos + length:
        return None
    payload = bytes(buf[pos : pos + length])
    del buf[: pos + length]
    if masked:
        payload = _xor(payload, key)
    if opcode & 0x08 and length > 125:
        raise WsError("control frame payload too long")
    return (fin, opcode, payload)


class MessageAssembler:
    """Reassembles fragmented data messages; keeps control frames apart.

    Feed every frame from :func:`read_frame` through one assembler per
    (connection, direction). ``feed`` returns:

      * ``None`` — a data frame of an in-flight fragmented message,
      * ``("message", opcode, payload)`` — one complete data message
        (reassembled if it was fragmented),
      * ``("control", opcode, payload)`` — a control frame, which may
        legally interleave between fragments (RFC 6455 5.4).

    Raises :class:`WsError` on protocol violations (continuation
    without initial frame, a new data message while one is in flight).
    """

    def __init__(self) -> None:
        self._opcode: int | None = None
        self._buf: bytearray | None = None

    def feed(self, fin: bool, opcode: int, payload: bytes):
        if opcode & 0x08:  # control frame
            if self._opcode is not None and not fin:
                raise WsError("control frame split a fragmented message")
            return ("control", opcode, payload)
        if opcode == OP_CONTINUATION:
            if self._opcode is None:
                raise WsError("continuation without initial frame")
            self._buf.extend(payload)
            if fin:
                done, self._opcode = self._opcode, None
                assembled, self._buf = bytes(self._buf), None
                return ("message", done, assembled)
            return None
        if self._opcode is not None:
            raise WsError("new data frame while a message is in flight")
        if fin:
            return ("message", opcode, payload)
        self._opcode = opcode
        self._buf = bytearray(payload)
        return None
