"""Minimal RFC 8949 CBOR codec for the Foxglove WebSocket protocol.

The gateway only needs to *inspect* protocol frames (which op, which topic)
and to emit tiny control frames (``error``). This is deliberately a small,
stdlib-only subset:

decode: unsigned/negative ints, byte strings, text strings, arrays, maps,
        booleans, null, floats (16/32/64), tags (as ``(tag, value)``).
encode: dict, list, str, bytes, int, bool, None, float.

Unknown or exotic items raise ``CborError``; the gateway treats that as
"cannot inspect" and fails closed (deny + audit).
"""

from __future__ import annotations

import struct

__all__ = ["CborError", "decode", "encode"]


class CborError(ValueError):
    """Malformed or unsupported CBOR data."""


def _read_head(data: bytes, pos: int) -> tuple[int, int, int]:
    """Read one major-type/length head. Returns (major, value, new_pos)."""
    if pos >= len(data):
        raise CborError("truncated head")
    initial = data[pos]
    pos += 1
    major = initial >> 5
    info = initial & 0x1F
    if info < 24:
        return major, info, pos
    if info == 24:
        if pos + 1 > len(data):
            raise CborError("truncated uint8")
        return major, data[pos], pos + 1
    if major == 7:
        # 0xF9/0xFA/0xFB: the "length" bytes are actually the float
        # payload; map them onto the 26/27/28 markers _decode_item uses.
        if info == 25:
            return major, 26, pos
        if info == 26:
            return major, 27, pos
        if info == 27:
            return major, 28, pos
        raise CborError("unsupported float encoding")
    if info == 25:
        if pos + 2 > len(data):
            raise CborError("truncated uint16")
        return major, struct.unpack_from(">H", data, pos)[0], pos + 2
    if info == 26:
        if pos + 4 > len(data):
            raise CborError("truncated uint32")
        return major, struct.unpack_from(">I", data, pos)[0], pos + 4
    if info == 27:
        if pos + 8 > len(data):
            raise CborError("truncated uint64")
        return major, struct.unpack_from(">Q", data, pos)[0], pos + 8
    if info in (30, 31):
        # 31 = indefinite length: unsupported (the protocol never uses it)
        raise CborError("indefinite-length items are not supported")
    raise CborError(f"bad length info {info}")


def _decode_item(data: bytes, pos: int, depth: int) -> tuple[object, int]:
    if depth > 32:
        raise CborError("nesting too deep")
    major, value, pos = _read_head(data, pos)

    if major == 0:  # unsigned int
        return value, pos
    if major == 1:  # negative int
        return -1 - value, pos
    if major == 2:  # byte string
        end = pos + value
        if end > len(data):
            raise CborError("truncated bstr")
        return bytes(data[pos:end]), end
    if major == 3:  # text string
        end = pos + value
        if end > len(data):
            raise CborError("truncated tstr")
        return data[pos:end].decode("utf-8"), end
    if major == 4:  # array
        items = []
        for _ in range(value):
            item, pos = _decode_item(data, pos, depth + 1)
            items.append(item)
        return items, pos
    if major == 5:  # map
        result = {}
        for _ in range(value):
            key, pos = _decode_item(data, pos, depth + 1)
            val, pos = _decode_item(data, pos, depth + 1)
            if not isinstance(key, (str, int, bytes)):
                raise CborError("unsupported map key type")
            result[key] = val
        return result, pos
    if major == 6:  # tag
        inner, pos = _decode_item(data, pos, depth + 1)
        return (value, inner), pos
    if major == 7:
        if value == 20:
            return False, pos
        if value == 21:
            return True, pos
        if value == 22:
            return None, pos
        if value == 23:  # undefined
            raise CborError("undefined is not supported")
        if value == 26:
            if pos + 2 > len(data):
                raise CborError("truncated float16")
            (half,) = struct.unpack_from(">h", data, pos)
            sign = -1.0 if half < 0 else 1.0
            exp = (half & 0x7FFF) >> 10
            mant = half & 0x3FF
            if exp == 0:
                return sign * mant * 2.0**-15, pos + 2
            if exp == 0x1F:
                raise CborError("float16 infinity/NaN not supported")
            return sign * (1.0 + mant / 1024.0) * 2.0 **(exp - 15), pos + 2
        if value == 27:
            if pos + 4 > len(data):
                raise CborError("truncated float32")
            return struct.unpack_from(">f", data, pos)[0], pos + 4
        if value == 28:
            if pos + 8 > len(data):
                raise CborError("truncated float64")
            return struct.unpack_from(">d", data, pos)[0], pos + 8
        # 0..19: reserved simple values
        raise CborError(f"unsupported simple value {value}")
    raise CborError(f"unknown major type {major}")


def decode(payload: bytes) -> object:
    """Decode exactly one CBOR item from ``payload``.

    Raises ``CborError`` if the payload is empty, malformed, or contains
    trailing bytes after the first item (protocol frames carry one item).
    """
    if not payload:
        raise CborError("empty payload")
    value, pos = _decode_item(payload, 0, 0)
    if pos != len(payload):
        raise CborError("trailing bytes after CBOR item")
    return value


def _encode_head(out: bytearray, major: int, value: int) -> None:
    if value < 24:
        out.append((major << 5) | value)
    elif value < 0x100:
        out.append((major << 5) | 24)
        out.append(value)
    elif value < 0x10000:
        out.append((major << 5) | 25)
        out.extend(struct.pack(">H", value))
    elif value < 0x100000000:
        out.append((major << 5) | 26)
        out.extend(struct.pack(">I", value))
    else:
        out.append((major << 5) | 27)
        out.extend(struct.pack(">Q", value))


def encode(value: object) -> bytes:
    """Encode a Python value to canonical-ish CBOR (subset)."""
    out = bytearray()

    def go(v: object) -> None:
        if isinstance(v, bool):
            out.append(0xF4 if v else 0xF5)
        elif v is None:
            out.append(0xF6)
        elif isinstance(v, int):
            if v >= 0:
                _encode_head(out, 0, v)
            else:
                _encode_head(out, 1, -1 - v)
        elif isinstance(v, str):
            data = v.encode("utf-8")
            _encode_head(out, 3, len(data))
            out.extend(data)
        elif isinstance(v, (bytes, bytearray)):
            _encode_head(out, 2, len(v))
            out.extend(v)
        elif isinstance(v, float):
            out.append(0xFB)
            out.extend(struct.pack(">d", v))
        elif isinstance(v, (list, tuple)):
            _encode_head(out, 4, len(v))
            for item in v:
                go(item)
        elif isinstance(v, dict):
            _encode_head(out, 5, len(v))
            for key, item in v.items():
                if not isinstance(key, str):
                    raise CborError("dict keys must be str for encoding")
                go(key)
                go(item)
        else:
            raise CborError(f"unsupported type {type(v).__name__}")

    go(value)
    return bytes(out)
