"""Extract plaintext from an iMessage NSAttributedString typedstream blob.

On macOS, messages composed in Messages.app store their text in
`message.attributedBody` (Apple's NSArchiver typedstream binary format)
instead of the plain `message.text` column. This module extracts the
primary visible text from that blob using a heuristic that works for
all text-only messages and degrades gracefully on attachments.

Format reference (enough for our case):
  - Header: b"streamtyped" + version bytes.
  - Class graph: NSAttributedString -> NSObject -> NSString.
  - Primary string: ... b"NSString" ... b"+" + length_bytes + UTF-8 bytes.

Length encoding after the b"+" instance marker:
  0x00..0x7F        -> length is that byte literal
  0x81, L16 (LE)    -> 16-bit length
  0x82, L32 (LE)    -> 32-bit length

This is not a general typedstream parser. We locate the first NSString
instance marker, read its length, and slice UTF-8. That is sufficient for
plain text (~all compliance traffic). Rich-text messages still carry
their visible text in this first NSString; formatting attributes are
stored in follow-on NSDictionary structures we ignore.
"""

from __future__ import annotations


def decode_attributed_body(blob: bytes | None) -> str | None:
    """Return the primary NSString from the typedstream, or None if absent."""
    if not blob or b"NSString" not in blob:
        return None

    # Find the instance marker '+' that follows the NSString class definition.
    ns_idx = blob.find(b"NSString")
    plus = blob.find(b"+", ns_idx)
    if plus == -1 or plus + 1 >= len(blob):
        return None

    i = plus + 1
    first = blob[i]
    if first == 0x81:
        if i + 3 > len(blob):
            return None
        length = int.from_bytes(blob[i + 1 : i + 3], "little")
        start = i + 3
    elif first == 0x82:
        if i + 5 > len(blob):
            return None
        length = int.from_bytes(blob[i + 1 : i + 5], "little")
        start = i + 5
    else:
        length = first
        start = i + 1

    if length <= 0 or start + length > len(blob):
        return None

    try:
        text = blob[start : start + length].decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text or None
