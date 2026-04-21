"""Drains the local outbound queue to the ingestion API."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx
import structlog

from .checkpoint import State

log = structlog.get_logger(__name__)

_MAX_ATTEMPTS = 20


def _backoff_seconds(attempt: int) -> int:
    # Exponential with cap: 2, 4, 8, 16, 32, 64, ... up to 900 (15min).
    return min(2**attempt, 900)


class Forwarder:
    def __init__(self, state: State, api_base_url: str, client: httpx.AsyncClient) -> None:
        self._state = state
        self._url = api_base_url.rstrip("/") + "/v1/ingest"
        self._client = client

    async def drain_once(self, batch_size: int) -> int:
        """Attempt to send one batch. Returns number of messages sent."""
        rows = self._state.peek_ready(batch_size)
        if not rows:
            return 0

        messages: list[dict[str, Any]] = []
        for row in rows:
            try:
                messages.append(json.loads(row["payload_json"]))
            except json.JSONDecodeError:
                # A corrupted row would block the queue; drop it and log.
                log.error("forwarder.invalid_payload", row_id=row["id"])
                self._state.mark_sent([row["id"]])

        if not messages:
            return 0

        envelope = {
            "messages": messages,
            "client_batch_id": str(uuid.uuid4()),
            # Placeholder: real signature is produced by the Secure Enclave
            # keyring in a later module. Until then, a stable non-empty string
            # lets the schema validate.
            "client_sig": "ecdsa-p256:unsigned-dev",
        }

        try:
            resp = await self._client.post(self._url, json=envelope, timeout=30)
        except httpx.HTTPError as exc:
            log.warning("forwarder.network_error", error=str(exc))
            for row in rows:
                self._state.mark_failed(row["id"], _backoff_seconds(row["attempts"] + 1))
            return 0

        if resp.status_code // 100 == 2:
            self._state.mark_sent([r["id"] for r in rows])
            log.info("forwarder.sent", count=len(rows))
            return len(rows)

        # 4xx: malformed payload or rejected auth. Drop after too many tries
        # so the queue doesn't block indefinitely, but keep long enough for
        # an operator to investigate. For 5xx we retry with backoff.
        body = resp.text[:500]
        log.warning("forwarder.http_error", status=resp.status_code, body=body)
        for row in rows:
            if resp.status_code < 500 and row["attempts"] >= _MAX_ATTEMPTS:
                log.error("forwarder.dropping", id=row["id"], attempts=row["attempts"])
                self._state.mark_sent([row["id"]])
            else:
                self._state.mark_failed(row["id"], _backoff_seconds(row["attempts"] + 1))
        return 0

    async def run_forever(self, batch_size: int, tick_seconds: float = 2.0) -> None:
        while True:
            try:
                sent = await self.drain_once(batch_size)
            except Exception:
                log.exception("forwarder.unhandled")
                sent = 0
            if sent == 0:
                await asyncio.sleep(tick_seconds)
