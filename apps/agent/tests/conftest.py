from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest

from archiveglp_agent.config import AgentConfig

# Minimal subset of the chat.db schema that the capture query depends on.
_SCHEMA = """
CREATE TABLE handle (
    ROWID INTEGER PRIMARY KEY,
    id TEXT,
    service TEXT
);
CREATE TABLE chat (
    ROWID INTEGER PRIMARY KEY,
    guid TEXT,
    chat_identifier TEXT,
    display_name TEXT
);
CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT,
    text TEXT,
    attributedBody BLOB,
    date INTEGER,
    date_edited INTEGER,
    handle_id INTEGER,
    is_from_me INTEGER,
    service TEXT,
    item_type INTEGER DEFAULT 0,
    associated_message_guid TEXT,
    associated_message_type INTEGER
);
CREATE TABLE chat_message_join (
    chat_id INTEGER,
    message_id INTEGER,
    PRIMARY KEY (chat_id, message_id)
);
"""


def _apple_ns(dt: datetime) -> int:
    """Convert a UTC datetime to Apple/Cocoa nanoseconds since 2001-01-01."""
    epoch = datetime(2001, 1, 1, tzinfo=UTC)
    return int((dt - epoch).total_seconds() * 1_000_000_000)


@pytest.fixture()
def chatdb_path(tmp_path: Path) -> Path:
    path = tmp_path / "chat.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(_SCHEMA)

    # Counterparty handle (client phone number).
    conn.execute(
        "INSERT INTO handle (ROWID, id, service) VALUES (1, '+15559876543', 'iMessage')",
    )
    # Conversation chat row.
    conn.execute(
        "INSERT INTO chat (ROWID, guid, chat_identifier, display_name) "
        "VALUES (1, 'iMessage;-;+15559876543', '+15559876543', NULL)",
    )

    # Inbound message.
    t1 = datetime(2026, 4, 21, 18, 0, 0, tzinfo=UTC)
    conn.execute(
        "INSERT INTO message (guid, text, date, handle_id, is_from_me, service, item_type) "
        "VALUES ('G1', 'hi from client', ?, 1, 0, 'iMessage', 0)",
        (_apple_ns(t1),),
    )
    conn.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)")

    # Outbound reply.
    t2 = datetime(2026, 4, 21, 18, 1, 0, tzinfo=UTC)
    conn.execute(
        "INSERT INTO message (guid, text, date, handle_id, is_from_me, service, item_type) "
        "VALUES ('G2', 'hi from advisor', ?, 1, 1, 'iMessage', 0)",
        (_apple_ns(t2),),
    )
    conn.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2)")

    # System row (group-name change), should be skipped.
    conn.execute(
        "INSERT INTO message (guid, text, date, handle_id, is_from_me, service, item_type) "
        "VALUES ('G3', NULL, ?, 1, 1, 'iMessage', 2)",
        (_apple_ns(t2),),
    )
    conn.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 3)")

    conn.commit()
    conn.close()
    return path


@pytest.fixture()
def agent_cfg(tmp_path: Path, chatdb_path: Path) -> AgentConfig:
    return AgentConfig(
        firm_id="firm_testco1",
        employee_id="emp_jane42",
        device_id="dev_mactest01",
        api_base_url="https://test.invalid",
        chatdb_path=chatdb_path,
        state_dir=tmp_path / "state",
        poll_interval_seconds=1.0,
        batch_size=100,
        agent_version="0.0.1-test",
    )


@pytest.fixture()
def device_key():
    from cryptography.hazmat.primitives.asymmetric import ec

    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture()
def server_signer():
    """Ephemeral backend command-signing keypair + helper to sign a
    command payload in the canonical format. Mirrors what the
    dashboard's `loadCommandSigner()` does for real."""
    import base64
    import json

    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    from archiveglp_agent.server_key import (
        ServerCommandKey,
        canonical_command_string,
    )

    _ = json  # used by caller-facing helper below
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key()
    spki_b64 = base64.b64encode(
        pub.public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    ).decode("ascii")
    key_id = "test-key-1"

    def sign_command(
        *,
        command_id: str,
        device_id: str,
        action: str,
        parameters=None,
        issued_at: str,
    ) -> dict:
        canonical = canonical_command_string(
            key_id, command_id, device_id, action, parameters, issued_at
        )
        sig = priv.sign(canonical, ec.ECDSA(hashes.SHA256()))
        return {
            "command_id": command_id,
            "device_id": device_id,
            "action": action,
            "parameters": parameters,
            "issued_at": issued_at,
            "key_id": key_id,
            "signature_b64": base64.b64encode(sig).decode("ascii"),
        }

    return {
        "key_id": key_id,
        "spki_b64": spki_b64,
        "server_key": ServerCommandKey(key_id=key_id, public_key=pub),
        "sign": sign_command,
    }
