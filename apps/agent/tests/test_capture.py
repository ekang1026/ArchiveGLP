from __future__ import annotations

from archiveglp_agent.capture import fetch_since, open_chatdb


def test_fetch_since_returns_rows_in_order(chatdb_path):
    with open_chatdb(chatdb_path) as conn:
        rows = fetch_since(conn, last_rowid=0, limit=100)
    assert [r["rowid"] for r in rows] == [1, 2, 3]
    assert rows[0]["text"] == "hi from client"
    assert rows[0]["is_from_me"] == 0
    assert rows[1]["is_from_me"] == 1
    # System rows come through at the SQL layer; normalization filters them.
    assert rows[2]["item_type"] == 2


def test_fetch_since_respects_checkpoint(chatdb_path):
    with open_chatdb(chatdb_path) as conn:
        rows = fetch_since(conn, last_rowid=2, limit=100)
    assert [r["rowid"] for r in rows] == [3]
