"""Agent heartbeat emitter.

Reports device health to the backend every ~60s. Uses its own outbound
path (not the message queue) so heartbeats aren't blocked by a backed-up
ingest queue.
"""

from __future__ import annotations

import asyncio
import json
import platform
from datetime import UTC, datetime

import httpx
import structlog
from cryptography.hazmat.primitives.asymmetric import ec

from .checkpoint import State
from .config import AgentConfig
from .schema import Heartbeat
from .signing import sign_request

log = structlog.get_logger(__name__)

_HEARTBEAT_PATH = "/v1/heartbeat"

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
        # Mirror the pump's pause marker up to the dashboard so the
        # remediation UI shows the correct "Pause / Resume" button
        # without waiting for a command-ack round-trip.
        paused=(cfg.state_dir / "paused").exists(),
    )


class HeartbeatEmitter:
    def __init__(
        self,
        cfg: AgentConfig,
        state: State,
        client: httpx.AsyncClient,
        private_key: ec.EllipticCurvePrivateKey,
    ) -> None:
        self._cfg = cfg
        self._state = state
        self._client = client
        self._key = private_key
        self._url = cfg.api_base_url.rstrip("/") + _HEARTBEAT_PATH

    async def send_once(self) -> int:
        hb = build_heartbeat(self._cfg, self._state)
        payload = hb.model_dump(mode="json", exclude_none=False)
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        signed = sign_request(
            self._key,
            device_id=self._cfg.device_id,
            method="POST",
            path=_HEARTBEAT_PATH,
            body=body,
        )
        try:
            resp = await self._client.post(
                self._url,
                content=body,
                headers={"content-type": "application/json", **signed.as_dict()},
                timeout=15,
            )
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
