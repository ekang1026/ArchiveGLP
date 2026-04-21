"""Incremental iMessage chat.db reader.

Opens chat.db read-only and polls for new rows by ROWID. The iMessage
database is live (Messages.app writes concurrently), so we:

- Open with ``mode=ro&immutable=0`` so SQLite honors WAL.
- Never copy the file (breaks WAL).
- Track the last processed ROWID in a separate local checkpoint DB.

chat.db Apple Epoch note: ``message.date`` is nanoseconds since 2001-01-01
UTC (Apple/Cocoa epoch), not the Unix epoch. We convert here.
"""

from __future__ import annotations

import contextlib
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# 2001-01-01 00:00:00 UTC, Cocoa reference date.
_APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=UTC)


def apple_ns_to_datetime(apple_ns: int | None) -> datetime | None:
    if apple_ns is None:
        return None
    # Older iMessage versions stored seconds; newer store nanoseconds. A value
    # smaller than ~1e12 is almost certainly seconds. Defensive switch:
    if apple_ns < 10**12:
        return _APPLE_EPOCH + timedelta(seconds=apple_ns)
    return _APPLE_EPOCH + timedelta(microseconds=apple_ns / 1000)


@contextlib.contextmanager
def open_chatdb(path: Path) -> Iterator[sqlite3.Connection]:
    """Open chat.db read-only with WAL honored."""
    # Using URI form so we can pass mode=ro; immutable=0 keeps SQLite
    # polling WAL instead of assuming the file never changes.
    uri = f"file:{path}?mode=ro&immutable=0"
    conn = sqlite3.connect(uri, uri=True, isolation_level=None, check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        yield conn
    finally:
        conn.close()


# Core query. Joins message to chat/handle so we get conversation + counterparties
# in one pass. Ordered by ROWID so pagination by ROWID is monotonic.
#
# attributedBody is a BLOB containing the NSArchiver/typedstream serialization
# of the NSAttributedString that Messages.app on macOS uses instead of `text`
# for messages composed in the app. We decode it in normalize.py when `text`
# is NULL/empty.
_CAPTURE_SQL = """
SELECT
    m.ROWID                      AS rowid,
    m.guid                       AS guid,
    m.text                       AS text,
    m.attributedBody             AS attributed_body,
    m.date                       AS date_apple_ns,
    m.date_edited                AS date_edited_apple_ns,
    m.is_from_me                 AS is_from_me,
    m.service                    AS service,
    m.item_type                  AS item_type,
    m.associated_message_guid    AS associated_message_guid,
    m.associated_message_type    AS associated_message_type,
    h.id                         AS counterparty_handle,
    c.chat_identifier            AS chat_identifier,
    c.display_name               AS chat_display_name,
    c.guid                       AS chat_guid
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > :last_rowid
ORDER BY m.ROWID ASC
LIMIT :limit
"""


def fetch_since(
    conn: sqlite3.Connection,
    last_rowid: int,
    limit: int,
) -> list[dict[str, Any]]:
    cur = conn.execute(_CAPTURE_SQL, {"last_rowid": last_rowid, "limit": limit})
    return [dict(row) for row in cur.fetchall()]
