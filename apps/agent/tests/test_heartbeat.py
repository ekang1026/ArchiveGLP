from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
import respx

from archiveglp_agent.checkpoint import State
from archiveglp_agent.heartbeat import HeartbeatEmitter, build_heartbeat
from archiveglp_agent.pump import CapturePump


def test_build_heartbeat_reports_queue_depth(agent_cfg):
    state = State(agent_cfg.state_dir / "agent.sqlite")
    CapturePump(agent_cfg, state).tick()
    hb = build_heartbeat(
        agent_cfg,
        state,
        now=datetime(2026, 4, 21, 18, 0, 0, tzinfo=UTC),
    )
    assert hb.firm_id == agent_cfg.firm_id
    assert hb.employee_id == agent_cfg.employee_id
    assert hb.device_id == agent_cfg.device_id
    assert hb.status == "healthy"
    # Two messages enqueued by the pump (one system row filtered).
    assert hb.queue_depth == 2
    state.close()


@pytest.mark.asyncio
async def test_emitter_posts_to_heartbeat_endpoint(agent_cfg):
    state = State(agent_cfg.state_dir / "agent.sqlite")
    async with httpx.AsyncClient() as client:
        emitter = HeartbeatEmitter(agent_cfg, state, client)
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            route = mock.post("/v1/heartbeat").respond(204)
            status = await emitter.send_once()
            assert status == 204
            assert route.called
            sent = route.calls[0].request.content
            assert b'"schema_version":1' in sent or b'"schema_version": 1' in sent
            assert agent_cfg.firm_id.encode() in sent
    state.close()


@pytest.mark.asyncio
async def test_emitter_returns_negative_on_network_error(agent_cfg):
    state = State(agent_cfg.state_dir / "agent.sqlite")
    async with httpx.AsyncClient() as client:
        emitter = HeartbeatEmitter(agent_cfg, state, client)
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            mock.post("/v1/heartbeat").mock(side_effect=httpx.ConnectError("down"))
            status = await emitter.send_once()
            assert status == -1
    state.close()
