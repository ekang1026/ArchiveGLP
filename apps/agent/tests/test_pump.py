from __future__ import annotations

import json

from archiveglp_agent.checkpoint import State
from archiveglp_agent.pump import CapturePump


def test_tick_enqueues_non_system_messages_and_advances_checkpoint(agent_cfg):
    state = State(agent_cfg.state_dir / "agent.sqlite")
    pump = CapturePump(agent_cfg, state)

    enqueued = pump.tick()
    # 2 real messages, 1 system row filtered out.
    assert enqueued == 2
    # Checkpoint moves past the last row we read, including the filtered one.
    assert state.get_last_rowid() == 3

    # Second tick sees no new rows.
    assert pump.tick() == 0

    payloads = [json.loads(r["payload_json"]) for r in state.peek_ready(100)]
    assert [p["direction"] for p in payloads] == ["inbound", "outbound"]
    assert payloads[0]["from"]["handle"] == "+15559876543"
    assert payloads[1]["from"]["handle"] == agent_cfg.employee_id
    assert payloads[0]["firm_id"] == agent_cfg.firm_id
    assert payloads[0]["source"] == "imessage"
    state.close()


def test_checkpoint_persists_across_restart(agent_cfg):
    s1 = State(agent_cfg.state_dir / "agent.sqlite")
    CapturePump(agent_cfg, s1).tick()
    assert s1.get_last_rowid() == 3
    s1.close()

    s2 = State(agent_cfg.state_dir / "agent.sqlite")
    assert s2.get_last_rowid() == 3
    # No new rows on a fresh process.
    assert CapturePump(agent_cfg, s2).tick() == 0
    s2.close()
