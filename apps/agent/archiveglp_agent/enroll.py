"""First-run enrollment: generate device keypair and register it.

Flow:
  1. Show disclosures. Employee types their name to attest. Without this
     the flow does not proceed.
  2. Generate ECDSA P-256 keypair (FileKeyStore persists it 0600).
  3. POST the attestation + pairing_code to /v1/enroll. The server creates
     the employee (if needed) and device rows and archives the attestation.
  4. Write a local ``enrolled`` marker so `run` won't re-prompt.

Enrollment is the only unauthenticated POST. Every subsequent request from
this device is signed with the private key we just generated.
"""

from __future__ import annotations

import json
import platform
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
import structlog

from .config import AgentConfig
from .keystore import KeyStore
from .schema import EnrollmentAttestation, EnrollmentRequest
from .server_key import persist_server_key

log = structlog.get_logger(__name__)

DISCLOSURES_VERSION = "2026-04-21.v1"
DISCLOSURES = [
    (
        "data-captured",
        "iMessage and SMS messages on this Mac, including sender, recipient, "
        "timestamp, message content, and attachments.",
    ),
    (
        "purpose",
        "Communications archiving required by SEC Rule 17a-4 and FINRA Rule 3110 "
        "for the firm's regulated business.",
    ),
    (
        "retention",
        "Your firm has configured a retention period under applicable SEC rules. "
        "Archived data cannot be shortened or deleted before the retention date.",
    ),
    (
        "visibility",
        "Your firm's compliance supervisors and their designated third-party auditor "
        "may read archived messages. All such access is itself logged.",
    ),
    (
        "revocation",
        "You may revoke this consent at any time by uninstalling the agent. Messages "
        "captured while the agent was running will remain archived for the full "
        "retention period per SEC 17a-4(f).",
    ),
]


@dataclass
class EnrollmentInput:
    pairing_code: str
    employee_email: str
    employee_full_name_typed: str


def build_request(
    cfg: AgentConfig,
    inp: EnrollmentInput,
    device_public_key_spki_b64: str,
    now: datetime | None = None,
) -> EnrollmentRequest:
    attestation = EnrollmentAttestation(
        firm_id=cfg.firm_id,
        employee_id=cfg.employee_id,
        device_id=cfg.device_id,
        employee_full_name_typed=inp.employee_full_name_typed,
        employee_email=inp.employee_email,
        disclosures_version=DISCLOSURES_VERSION,
        disclosures_shown=[key for key, _ in DISCLOSURES],
        attested_at=now or datetime.now(UTC),
        device_public_key_spki_b64=device_public_key_spki_b64,
        os_version=f"{platform.system()} {platform.release()}",
        agent_version=cfg.agent_version,
    )
    return EnrollmentRequest(pairing_code=inp.pairing_code, attestation=attestation)


async def enroll(
    cfg: AgentConfig,
    keystore: KeyStore,
    inp: EnrollmentInput,
    client: httpx.AsyncClient,
) -> int:
    """Execute the enrollment POST. Returns HTTP status (-1 on network error)."""
    keystore.load_or_create()
    req = build_request(cfg, inp, keystore.public_key_spki_b64())
    body = json.dumps(req.model_dump(mode="json"), separators=(",", ":")).encode("utf-8")
    url = cfg.api_base_url.rstrip("/") + "/v1/enroll"
    try:
        resp = await client.post(
            url,
            content=body,
            headers={"content-type": "application/json"},
            timeout=30,
        )
    except httpx.HTTPError as exc:
        log.warning("enroll.network_error", error=str(exc))
        return -1

    if resp.status_code // 100 == 2:
        # Persist the backend's command-signing public key. This is
        # our one authenticated shot at distributing it (the pairing
        # code we just consumed authorized the response). Without
        # this key the CommandExecutor refuses to run any remediation
        # — a fail-closed posture against MITM.
        try:
            payload = resp.json() if resp.content else {}
        except ValueError:
            payload = {}
        key_id = payload.get("server_command_key_id")
        spki_b64 = payload.get("server_command_key_spki_b64")
        if key_id and spki_b64:
            persist_server_key(cfg.state_dir, key_id, spki_b64)
            log.info("enroll.server_key_persisted", key_id=key_id)
        else:
            # Old dashboard versions returned 204. Don't write the
            # marker: better to force the operator to upgrade than to
            # ship a device that cannot verify remediation commands.
            log.error("enroll.server_key_missing_in_response")
            return resp.status_code

        marker = cfg.state_dir / "enrolled"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(req.attestation.attested_at.isoformat())
        log.info("enroll.ok", status=resp.status_code)
    else:
        log.warning("enroll.http_error", status=resp.status_code, body=resp.text[:500])
    return resp.status_code
