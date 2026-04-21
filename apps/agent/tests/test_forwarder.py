from __future__ import annotations

import httpx
import pytest
import respx

from archiveglp_agent.checkpoint import State
from archiveglp_agent.forwarder import Forwarder
from archiveglp_agent.pump import CapturePump


@pytest.mark.asyncio
async def test_forwarder_sends_and_drains_queue(agent_cfg):
    state = State(agent_cfg.state_dir / "agent.sqlite")
    CapturePump(agent_cfg, state).tick()
    assert state.queue_depth() == 2

    async with httpx.AsyncClient() as client:
        forwarder = Forwarder(state, agent_cfg.api_base_url, client)
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            route = mock.post("/v1/ingest").respond(202, json={"accepted": 2})
            sent = await forwarder.drain_once(batch_size=10)
            assert sent == 2
            assert route.called
            assert state.queue_depth() == 0

    state.close()


@pytest.mark.asyncio
async def test_forwarder_retries_on_5xx(agent_cfg):
    state = State(agent_cfg.state_dir / "agent.sqlite")
    CapturePump(agent_cfg, state).tick()

    async with httpx.AsyncClient() as client:
        forwarder = Forwarder(state, agent_cfg.api_base_url, client)
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            mock.post("/v1/ingest").respond(503, text="overloaded")
            sent = await forwarder.drain_once(batch_size=10)
            assert sent == 0
            # Nothing was drained; attempts were incremented.
            assert state.queue_depth() == 2
            assert state.max_attempts() >= 1

    state.close()
