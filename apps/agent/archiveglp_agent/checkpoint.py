"""Local checkpoint and outbound queue, backed by SQLite."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS checkpoint (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    payload_json TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_try_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS outbound_next_try_idx ON outbound (next_try_at);

-- Record of remediation commands the agent has already executed, keyed
-- by server command_id. The server re-delivers commands whose acks it
-- didn't record; the agent uses this log to suppress duplicate side-
-- effects (running revoke twice, rebooting twice, etc.) while still
-- re-acking so the server can close the loop.
CREATE TABLE IF NOT EXISTS executed_command (
    command_id  TEXT PRIMARY KEY,
    action      TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now')),
    result_json TEXT,
    error_text  TEXT
);
"""


class State:
    """Agent-local persistent state. WAL mode for crash-safety."""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), isolation_level=None, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(_SCHEMA)

    # ---- Checkpoint ----

    def get_last_rowid(self) -> int:
        row = self._conn.execute(
            "SELECT value FROM checkpoint WHERE key = 'imessage_last_rowid'",
        ).fetchone()
        return int(row["value"]) if row else 0

    def set_last_rowid(self, rowid: int) -> None:
        self._conn.execute(
            """
            INSERT INTO checkpoint (key, value) VALUES ('imessage_last_rowid', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (rowid,),
        )

    # ---- Outbound queue ----

    def enqueue(self, payload_json: str) -> None:
        self._conn.execute("INSERT INTO outbound (payload_json) VALUES (?)", (payload_json,))

    def peek_ready(self, limit: int) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT id, payload_json, attempts FROM outbound
            WHERE next_try_at <= datetime('now')
            ORDER BY id ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def mark_sent(self, ids: list[int]) -> None:
        if not ids:
            return
        placeholders = ",".join("?" * len(ids))
        self._conn.execute(f"DELETE FROM outbound WHERE id IN ({placeholders})", ids)

    def mark_failed(self, id_: int, backoff_seconds: int) -> None:
        self._conn.execute(
            """
            UPDATE outbound
            SET attempts = attempts + 1,
                next_try_at = datetime('now', ? )
            WHERE id = ?
            """,
            (f"+{backoff_seconds} seconds", id_),
        )

    def queue_depth(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) AS n FROM outbound").fetchone()
        return int(row["n"])

    def max_attempts(self) -> int:
        row = self._conn.execute("SELECT COALESCE(MAX(attempts), 0) AS a FROM outbound").fetchone()
        return int(row["a"])

    # ---- Executed-command log (idempotent remediation) ----

    def was_command_executed(self, command_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT command_id, action, result_json, error_text "
            "FROM executed_command WHERE command_id = ?",
            (command_id,),
        ).fetchone()
        return dict(row) if row else None

    def record_command_executed(
        self,
        command_id: str,
        action: str,
        result_json: str | None,
        error_text: str | None,
    ) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO executed_command "
            "(command_id, action, result_json, error_text) VALUES (?, ?, ?, ?)",
            (command_id, action, result_json, error_text),
        )

    def close(self) -> None:
        self._conn.close()
