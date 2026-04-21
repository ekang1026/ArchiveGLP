"""Map raw chat.db rows to the canonical Message schema."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .capture import apple_ns_to_datetime
from .config import AgentConfig
from .schema import Handle, Message


def _employee_handle(cfg: AgentConfig) -> Handle:
    # Placeholder identity. In production the enrollment step captures the
    # employee's Apple ID handle(s) (email + phone) and we persist them.
    return Handle(handle=cfg.employee_id)


def normalize_row(row: dict[str, Any], cfg: AgentConfig) -> Message | None:
    """Transform one chat.db row into a canonical Message. Returns None to skip
    system rows that aren't messages (typing indicators, audio-message expiry)."""

    item_type = row.get("item_type") or 0
    # item_type 0 = normal message; others are group-add, name-change, etc.
    # For MVP we archive only real messages. Group-meta events are a v2 add.
    if item_type != 0:
        return None

    text = row.get("text") or ""
    captured_at = apple_ns_to_datetime(row.get("date_apple_ns")) or datetime.now(UTC)

    is_from_me = bool(row.get("is_from_me"))
    direction = "outbound" if is_from_me else "inbound"

    counterparty = row.get("counterparty_handle") or row.get("chat_identifier") or "unknown"
    counterparty_handle = Handle(handle=counterparty)

    if is_from_me:
        from_h = _employee_handle(cfg)
        to_h = [counterparty_handle]
    else:
        from_h = counterparty_handle
        to_h = [_employee_handle(cfg)]

    service = (row.get("service") or "iMessage").lower()
    source = "imessage" if service == "imessage" else "sms"

    conversation_id = (
        row.get("chat_guid") or row.get("chat_identifier") or f"handle:{counterparty}"
    )

    message_id = f"imsg:rowid={row['rowid']}:guid={row.get('guid') or ''}"

    edited_at = apple_ns_to_datetime(row.get("date_edited_apple_ns"))
    unsent = False
    if row.get("associated_message_type") == 2:
        unsent = True

    msg = Message.model_validate(
        {
            "schema_version": 1,
            "firm_id": cfg.firm_id,
            "employee_id": cfg.employee_id,
            "device_id": cfg.device_id,
            "source": source,
            "conversation_id": conversation_id,
            "message_id": message_id,
            "captured_at": captured_at,
            "direction": direction,
            "from": from_h.model_dump(exclude_none=True),
            "to": [h.model_dump(exclude_none=True) for h in to_h],
            "body_text": text,
            "body_edits": (
                [{"at": edited_at, "text": text}] if edited_at and edited_at > captured_at else []
            ),
            "unsent": unsent,
            "attachments": [],
            "raw_source": {k: v for k, v in row.items() if v is not None},
        }
    )
    return msg
