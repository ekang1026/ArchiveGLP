"""Agent heartbeat emitter.

Reports device health to the backend every ~60s. Uses its own outbound
path (not the message queue) so heartbeats aren't blocked by a backed-up
ingest queue.
"""

from __future__ import annotations

import asyncio
import platform
from datetime import UTC, datetime

import httpx
import structlog

from .checkpoint import State
from .config import AgentConfig
from .schema import Heartbeat

log = structlog.get_logger(__name__)

HEARTBEAT_INTERVAL_SECONDS = 60


def _last_captured_at_from_rowid(state: State) -> datetime | None:
    # MVP: the agent doesn't currently track wall-clock of last capture.
    # Returning None is accurate and honest; a later change can add a
    # captured_at column to the checkpoint table.
    _ = state
    return None


def build_heartbeat(cfg: AgentConfig, state: State, now: datetime | None = None) -> Heartbeat:
    return Heartbeat(
        firm_id=cfg.firm_id,
        employee_id=cfg.employee_id,
        device_id=cfg.device_id,
        agent_version=cfg.agent_version,
        os_version=f"{platform.system()} {platform.release()}",
        status="healthy",
        reported_at=now or datetime.now(UTC),
        last_captured_at=_last_captured_at_from_rowid(state),
        queue_depth=state.queue_depth(),
        clock_skew_ms=0,
    )


class HeartbeatEmitter:
    def __init__(self, cfg: AgentConfig, state: State, client: httpx.AsyncClient) -> None:
        self._cfg = cfg
        self._state = state
        self._client = client
        self._url = cfg.api_base_url.rstrip("/") + "/v1/heartbeat"

    async def send_once(self) -> int:
        hb = build_heartbeat(self._cfg, self._state)
        payload = hb.model_dump(mode="json", exclude_none=False)
        try:
            resp = await self._client.post(self._url, json=payload, timeout=15)
        except httpx.HTTPError as exc:
            log.warning("heartbeat.network_error", error=str(exc))
            return -1

        if resp.status_code // 100 != 2:
            log.warning("heartbeat.http_error", status=resp.status_code, body=resp.text[:200])
        return resp.status_code

    async def run_forever(self) -> None:
        while True:
            try:
                await self.send_once()
            except Exception:
                log.exception("heartbeat.unhandled")
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
