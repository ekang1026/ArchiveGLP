from __future__ import annotations

from archiveglp_agent.normalize import normalize_row


def _row(**overrides):
    base = {
        "rowid": 42,
        "guid": "G-attr",
        "text": None,
        "attributed_body": None,
        "date_apple_ns": 800_000_000 * 10**9,
        "date_edited_apple_ns": None,
        "is_from_me": 1,
        "service": "iMessage",
        "item_type": 0,
        "associated_message_guid": None,
        "associated_message_type": None,
        "counterparty_handle": "+15551234567",
        "chat_identifier": "+15551234567",
        "chat_display_name": None,
        "chat_guid": "iMessage;-;+15551234567",
    }
    base.update(overrides)
    return base


def test_prefers_text_column_when_set(agent_cfg):
    msg = normalize_row(_row(text="plain text wins"), agent_cfg)
    assert msg is not None
    assert msg.body_text == "plain text wins"


def test_falls_back_to_attributed_body_when_text_is_null(agent_cfg):
    # Real blob captured from a Mac composing "hello hello" in Messages.app.
    blob = bytes.fromhex(
        "040B73747265616D747970656481E803840140848484124E"
        "5341747472696275746564537472696E67008484084E534F626A656374008592"
        "848484084E53537472696E67019484012B0B68656C6C6F2068656C6C6F868402"
        "6949010B928484840C4E5344696374696F6E617279009484016901928496961D"
        "5F5F6B494D4D657373616765506172744174747269627574654E616D65869284"
        "8484084E534E756D626572008484074E5356616C7565009484012A8499990086"
        "8686"
    )
    msg = normalize_row(_row(text=None, attributed_body=blob), agent_cfg)
    assert msg is not None
    assert msg.body_text == "hello hello"


def test_bytes_in_attributed_body_do_not_leak_into_raw_source(agent_cfg):
    """BLOB columns must not land in raw_source - JSON cannot encode bytes."""
    blob = b"fake-blob-\x00\x01\x02"
    msg = normalize_row(_row(text="visible", attributed_body=blob), agent_cfg)
    assert msg is not None
    assert msg.raw_source is not None
    assert "attributed_body" not in msg.raw_source


def test_empty_text_and_no_attributed_body_yields_empty_string(agent_cfg):
    msg = normalize_row(_row(text=None, attributed_body=None), agent_cfg)
    assert msg is not None
    assert msg.body_text == ""
