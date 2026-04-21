from __future__ import annotations

import httpx
import pytest
import respx

from archiveglp_agent.checkpoint import State
from archiveglp_agent.commands import CommandExecutor
from archiveglp_agent.pump import CapturePump


def _fresh_state(cfg):
    return State(cfg.state_dir / "agent.sqlite")


@pytest.mark.asyncio
async def test_resync_rewinds_checkpoint(agent_cfg, device_key):
    state = _fresh_state(agent_cfg)
    CapturePump(agent_cfg, state).tick()
    # After tick, checkpoint advanced to last processed rowid (>=2).
    assert state.get_last_rowid() > 0
    before = state.get_last_rowid()

    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            ack = mock.post("/v1/commands").respond(204)
            await cmd.execute({"command_id": "00000000-0000-0000-0000-000000000001", "action": "resync"})
            assert ack.called
    assert state.get_last_rowid() == 0
    assert before > 0
    state.close()


@pytest.mark.asyncio
async def test_pause_sets_marker_and_pump_skips(agent_cfg, device_key):
    state = _fresh_state(agent_cfg)

    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            await cmd.execute({"command_id": "00000000-0000-0000-0000-000000000002", "action": "pause"})

    paused = agent_cfg.state_dir / "paused"
    assert paused.exists()

    pump = CapturePump(agent_cfg, state)
    assert pump.tick() == 0
    assert state.queue_depth() == 0
    state.close()


@pytest.mark.asyncio
async def test_resume_clears_marker(agent_cfg, device_key):
    state = _fresh_state(agent_cfg)
    paused = agent_cfg.state_dir / "paused"
    paused.parent.mkdir(parents=True, exist_ok=True)
    paused.touch()

    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            await cmd.execute({"command_id": "00000000-0000-0000-0000-000000000003", "action": "resume"})
    assert not paused.exists()
    state.close()


@pytest.mark.asyncio
async def test_unknown_action_acks_with_error(agent_cfg, device_key):
    state = _fresh_state(agent_cfg)
    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        posted_body = None
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            route = m.post("/v1/commands").respond(204)
            await cmd.execute({"command_id": "00000000-0000-0000-0000-000000000004", "action": "self-destruct"})
            assert route.called
            posted_body = route.calls[0].request.content
    assert b"unknown action" in posted_body
    state.close()


@pytest.mark.asyncio
async def test_revoke_wipes_state_and_raises_system_exit(agent_cfg, device_key):
    state = _fresh_state(agent_cfg)
    assert agent_cfg.state_dir.exists()

    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            with pytest.raises(SystemExit) as exc:
                await cmd.execute({"command_id": "00000000-0000-0000-0000-000000000005", "action": "revoke"})
            assert exc.value.code == 0

    # Entire state directory is gone.
    assert not agent_cfg.state_dir.exists()


@pytest.mark.asyncio
async def test_poll_returns_commands_list(agent_cfg, device_key):
    state = _fresh_state(agent_cfg)
    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.get("/v1/commands").respond(
                200,
                json={
                    "commands": [
                        {"command_id": "abc", "action": "pause", "parameters": None},
                    ],
                },
            )
            result = await cmd.poll()
            assert len(result) == 1
            assert result[0]["action"] == "pause"
    state.close()
