from __future__ import annotations

from archiveglp_agent.attributed_body import decode_attributed_body

# Real-world blob captured from a Mac mini's chat.db, ROWID 5.
# Composed in Messages.app on macOS; body was "hello hello".
REAL_BLOB_HEX = (
    "040B73747265616D747970656481E803840140848484124E"
    "5341747472696275746564537472696E67008484084E534F626A656374008592"
    "848484084E53537472696E67019484012B0B68656C6C6F2068656C6C6F868402"
    "6949010B928484840C4E5344696374696F6E617279009484016901928496961D"
    "5F5F6B494D4D657373616765506172744174747269627574654E616D65869284"
    "8484084E534E756D626572008484074E5356616C7565009484012A8499990086"
    "8686"
)

REAL_BLOB = bytes.fromhex(REAL_BLOB_HEX)


def test_decodes_real_imessage_blob():
    assert decode_attributed_body(REAL_BLOB) == "hello hello"


def test_none_and_empty_inputs():
    assert decode_attributed_body(None) is None
    assert decode_attributed_body(b"") is None


def test_blob_without_nsstring_returns_none():
    assert decode_attributed_body(b"not a typedstream at all") is None


def _make_blob(text: bytes, *, length_prefix: bytes) -> bytes:
    """Build a minimal synthetic NSString typedstream fragment."""
    return (
        b"streamtyped\x04"
        + b"NSString"
        + b"\x01\x94\x84\x01+"  # class-info + '+' instance marker
        + length_prefix
        + text
    )


def test_short_ascii_single_byte_length():
    utf = b"hi there"
    blob = _make_blob(utf, length_prefix=bytes([len(utf)]))
    assert decode_attributed_body(blob) == "hi there"


def test_long_string_uses_0x81_length_prefix():
    text = "x" * 400
    utf = text.encode("utf-8")
    prefix = b"\x81" + len(utf).to_bytes(2, "little")
    assert decode_attributed_body(_make_blob(utf, length_prefix=prefix)) == text


def test_unicode_message():
    text = "👋 hello"
    utf = text.encode("utf-8")
    assert (
        decode_attributed_body(_make_blob(utf, length_prefix=bytes([len(utf)])))
        == text
    )


def test_zero_length_returns_none():
    blob = _make_blob(b"", length_prefix=b"\x00")
    assert decode_attributed_body(blob) is None


def test_truncated_length_returns_none():
    # Length byte says 100 but only 5 bytes follow.
    blob = _make_blob(b"abcde", length_prefix=bytes([100]))
    assert decode_attributed_body(blob) is None
