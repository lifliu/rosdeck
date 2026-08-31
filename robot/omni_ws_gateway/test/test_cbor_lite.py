import os
import struct
import sys
import unittest

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omni_ws_gateway import cbor_lite  # noqa: E402


class DecodeVectors(unittest.TestCase):
    """RFC 8949 Appendix A sample encodings (subset)."""

    def run_subtests(self):
        vectors = [
            (b"\x00", 0),
            (b"\x18\x18", 24),
            (b"\x18\x19", 25),
            (b"\x39\x03\xe8", 1000),
            (b"\x1a\x00\x0f\x42\x44", 1000000),
            (b"\x20", -1),
            (b"\x29", -10),
            (b"\x38\x63", 99),
            (b"\x40", b""),
            (b"\x44foo", b"foo"),
            (b"\x61a", "a"),
            (b"\x80", []),
            (b"\x83\x01\x02\x03", [1, 2, 3]),
            (b"\x82\x84\x01\x02\x82\x03\x04\x81\x05", [[1, 2], [3, 4], [5]]),
            (b'\xa1\x61a\x01', {"a": 1}),
            (b'\xa2\x61a\x62b\x61c\x63d', {"a": "b", "c": "d"}),
            (b"\xf4", True),
            (b"\xf5", False),
            (b"\xf6", None),
        ]
        for data, expected in vectors:
            with self.subTest(data=data.hex()):
                self.assertEqual(cbor_lite.decode(data), expected)

    def test_floats(self):
        self.assertAlmostEqual(cbor_lite.decode(b"\xf9\x3c\x00"), 1.0)
        self.assertAlmostEqual(
            cbor_lite.decode(b"\xfb\x40\x09\x21\xfb\x54\x44\x2d\x18"),
            3.141592653589793,
        )
        self.assertAlmostEqual(
            cbor_lite.decode(b"\xfa" + struct.pack(">f", 3.14159)),
            3.14159, places=5,
        )

    def test_tag(self):
        self.assertEqual(
            cbor_lite.decode(b'\xc1\x742013-03-21T20:04:00Z'),
            (1, "2013-03-21T20:04:00Z"),
        )

    def test_errors(self):
        for bad in (b"", b"\x5f", b"\x00\x00", b"\x61", b"\x1b",
                   b"\x9f", b"\x19\xff\xff\xff\xff\xff\xff\xff\xff"):
            with self.subTest(data=bad.hex()):
                with self.assertRaises(cbor_lite.CborError):
                    cbor_lite.decode(bad)

    def test_deep_nesting_rejected(self):
        data = b"\x81" * 40 + b"\x00"
        with self.assertRaises(cbor_lite.CborError):
            cbor_lite.decode(data)


class EncodeRoundTrip(unittest.TestCase):
    def run_subtests(self):
        values = [
            0, 1, 23, 24, 255, 256, 65535, 65536, 2 ** 32, 2 ** 64 - 1,
            -1, -2, -25, -1000000,
            "", "a", "hello world", "中文",
            b"", b"\x00\x01\x02", b"foo",
            True, False, None,
            1.0, -0.5, 3.141592653589793,
            [], [1, 2, 3], [[1, 2], [3, 4], [5]],
            {}, {"a": 1, "b": [1, 2], "c": None, "d": "x"},
        ]
        for value in values:
            with self.subTest(value=repr(value)[:60]):
                self.assertEqual(cbor_lite.decode(cbor_lite.encode(value)), value)

    def test_rejects_unsupported_types(self):
        with self.assertRaises(cbor_lite.CborError):
            cbor_lite.encode({1: "int key"})
        with self.assertRaises(cbor_lite.CborError):
            cbor_lite.encode(object())


if __name__ == "__main__":
    unittest.main()
