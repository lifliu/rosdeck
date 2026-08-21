import os
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_ws_gateway import ws_frames  # noqa: E402


class AcceptKey(unittest.TestCase):
    def test_rfc6455_sample(self):
        # RFC 6455 section 1.3 example
        self.assertEqual(
            ws_frames.accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        )


class FrameCodec(unittest.TestCase):
    KEY = b"\x11\x22\x33\x44"

    def _roundtrip(self, opcode, payload, masked=True):
        key = self.KEY if masked else None
        frame = ws_frames.build_frame(opcode, payload, mask_key=key)
        buf = bytearray(frame)
        result = ws_frames.read_frame(buf)
        self.assertEqual((True, opcode, payload), result)
        self.assertEqual(0, len(buf))

    def test_small_payload(self):
        self._roundtrip(ws_frames.OP_TEXT, b"hello")
        self._roundtrip(ws_frames.OP_BINARY, b"")

    def test_16bit_length(self):
        self._roundtrip(ws_frames.OP_BINARY, b"x" * 300)

    def test_64bit_length(self):
        self._roundtrip(ws_frames.OP_BINARY, b"y" * 70000)

    def test_unmasked_server_frame(self):
        self._roundtrip(ws_frames.OP_TEXT, b"server", masked=False)

    def test_mask_bit_is_in_length_byte(self):
        frame = ws_frames.build_frame(ws_frames.OP_TEXT, b"hi",
                                      mask_key=self.KEY)
        # FIN=1, MASK=1, opcode=1 in byte 0; MASK set in byte 1
        self.assertEqual(0x81, frame[0])
        self.assertTrue(frame[1] & 0x80)

    def test_exact_boundary_lengths(self):
        for n in (125, 126, 127, 0xFFFF, 0xFFFF + 1):
            with self.subTest(n=n):
                self._roundtrip(ws_frames.OP_BINARY, b"z" * n)

    def test_reserved_opcode_rejected(self):
        frame = ws_frames.build_frame(0x3, b"x", mask_key=self.KEY)
        with self.assertRaises(ws_frames.WsError):
            ws_frames.read_frame(bytearray(frame))

    def test_incomplete_frame_returns_none(self):
        frame = ws_frames.build_frame(ws_frames.OP_TEXT, b"abcd",
                                      mask_key=self.KEY)
        for i in range(1, len(frame)):
            buf = bytearray(frame[:i])
            self.assertIsNone(ws_frames.read_frame(buf))

    def test_control_frame_too_long(self):
        frame = ws_frames.build_frame(ws_frames.OP_CLOSE, b"x" * 126,
                                      mask_key=self.KEY)
        with self.assertRaises(ws_frames.WsError):
            ws_frames.read_frame(bytearray(frame))


class Assembler(unittest.TestCase):
    KEY = b"\x11\x22\x33\x44"

    def _frame(self, opcode, payload, fin=True, masked=True):
        key = self.KEY if masked else None
        frame = ws_frames.build_frame(opcode, payload, mask_key=key)
        if not fin:
            frame = bytes([frame[0] & 0x7F]) + frame[1:]
        return frame

    def test_single_frame_message(self):
        asm = ws_frames.MessageAssembler()
        _fin, opcode, payload = ws_frames.read_frame(
            bytearray(self._frame(ws_frames.OP_TEXT, b"hello"))
        )
        self.assertEqual(("message", ws_frames.OP_TEXT, b"hello"),
                         asm.feed(_fin, opcode, payload))

    def test_fragmented_message(self):
        asm = ws_frames.MessageAssembler()
        buf = bytearray(self._frame(ws_frames.OP_BINARY, b"part1-",
                                    fin=False))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        self.assertIsNone(asm.feed(_fin, opcode, payload))
        buf.extend(self._frame(ws_frames.OP_CONTINUATION, b"part2"))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        self.assertEqual(
            ("message", ws_frames.OP_BINARY, b"part1-part2"),
            asm.feed(_fin, opcode, payload),
        )

    def test_control_frame_between_fragments(self):
        asm = ws_frames.MessageAssembler()
        buf = bytearray(self._frame(ws_frames.OP_TEXT, b"a", fin=False))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        self.assertIsNone(asm.feed(_fin, opcode, payload))
        # the ping surfaces before the continuation completes
        buf.extend(self._frame(ws_frames.OP_PING, b"p"))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        self.assertEqual(("control", ws_frames.OP_PING, b"p"),
                         asm.feed(_fin, opcode, payload))
        buf.extend(self._frame(ws_frames.OP_CONTINUATION, b"b"))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        self.assertEqual(("message", ws_frames.OP_TEXT, b"ab"),
                         asm.feed(_fin, opcode, payload))

    def test_continuation_without_initial(self):
        asm = ws_frames.MessageAssembler()
        frame = self._frame(ws_frames.OP_CONTINUATION, b"x")
        _fin, opcode, payload = ws_frames.read_frame(bytearray(frame))
        with self.assertRaises(ws_frames.WsError):
            asm.feed(_fin, opcode, payload)

    def test_new_data_frame_while_in_flight(self):
        asm = ws_frames.MessageAssembler()
        buf = bytearray(self._frame(ws_frames.OP_TEXT, b"a", fin=False))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        asm.feed(_fin, opcode, payload)
        buf.extend(self._frame(ws_frames.OP_TEXT, b"b"))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        with self.assertRaises(ws_frames.WsError):
            asm.feed(_fin, opcode, payload)

    def test_assembler_state_resets_after_message(self):
        asm = ws_frames.MessageAssembler()
        buf = bytearray(
            self._frame(ws_frames.OP_TEXT, b"one", fin=False)
            + self._frame(ws_frames.OP_CONTINUATION, b"")
        )
        while True:
            _fin, opcode, payload = ws_frames.read_frame(buf)
            if _fin:
                break
            asm.feed(_fin, opcode, payload)
        self.assertEqual(("message", ws_frames.OP_TEXT, b"one"),
                         asm.feed(_fin, opcode, payload))
        # a plain message still works afterwards
        buf.extend(self._frame(ws_frames.OP_BINARY, b"two"))
        _fin, opcode, payload = ws_frames.read_frame(buf)
        self.assertEqual(("message", ws_frames.OP_BINARY, b"two"),
                         asm.feed(_fin, opcode, payload))


class CloseFrame(unittest.TestCase):
    def test_close_frame_roundtrip(self):
        frame = ws_frames.close_frame(1008, "login failed")
        _fin, opcode, payload = ws_frames.read_frame(bytearray(frame))
        self.assertEqual(ws_frames.OP_CLOSE, opcode)
        self.assertEqual(1008, int.from_bytes(payload[:2], "big"))
        self.assertEqual(b"login failed", payload[2:])


if __name__ == "__main__":
    unittest.main()
