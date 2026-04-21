"""Capture loop: reads new chat.db rows and enqueues canonical messages."""

from __future__ import annotations

import asyncio

import structlog

from .capture import fetch_since, open_chatdb
from .checkpoint import State
from .config import AgentConfig
from .normalize import normalize_row

log = structlog.get_logger(__name__)


class CapturePump:
    def __init__(self, cfg: AgentConfig, state: State) -> None:
        self._cfg = cfg
        self._state = state

    def _paused(self) -> bool:
        return (self._cfg.state_dir / "paused").exists()

    def tick(self) -> int:
        if self._paused():
            return 0
        last_rowid = self._state.get_last_rowid()
        with open_chatdb(self._cfg.chatdb_path) as conn:
            rows = fetch_since(conn, last_rowid=last_rowid, limit=self._cfg.batch_size)

        if not rows:
            return 0

        max_rowid = last_rowid
        enqueued = 0
        for row in rows:
            msg = normalize_row(row, self._cfg)
            max_rowid = max(max_rowid, int(row["rowid"]))
            if msg is None:
                continue
            self._state.enqueue(
                msg.model_dump_json(by_alias=True, exclude_none=True),
            )
            enqueued += 1

        self._state.set_last_rowid(max_rowid)
        if enqueued:
            log.info(
                "pump.captured",
                enqueued=enqueued,
                advanced_to_rowid=max_rowid,
            )
        return enqueued

    async def run_forever(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:
                log.exception("pump.unhandled")
            await asyncio.sleep(self._cfg.poll_interval_seconds)
