from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest
import respx

from archiveglp_agent.enroll import (
    DISCLOSURES,
    DISCLOSURES_VERSION,
    EnrollmentInput,
    build_request,
    enroll,
)
from archiveglp_agent.keystore import FileKeyStore


def test_build_request_populates_attestation(agent_cfg):
    ks = FileKeyStore(agent_cfg.state_dir / "device.key")
    ks.load_or_create()
    req = build_request(
        agent_cfg,
        EnrollmentInput(
            pairing_code="abcdefghijklmnop12345",
            employee_email="jane@firm.example",
            employee_full_name_typed="Jane Q Advisor",
        ),
        device_public_key_spki_b64=ks.public_key_spki_b64(),
        now=datetime(2026, 4, 21, 18, 0, 0, tzinfo=UTC),
    )
    assert req.pairing_code == "abcdefghijklmnop12345"
    assert req.attestation.firm_id == agent_cfg.firm_id
    assert req.attestation.employee_id == agent_cfg.employee_id
    assert req.attestation.device_id == agent_cfg.device_id
    assert req.attestation.employee_email == "jane@firm.example"
    assert req.attestation.employee_full_name_typed == "Jane Q Advisor"
    assert req.attestation.disclosures_version == DISCLOSURES_VERSION
    assert req.attestation.disclosures_shown == [k for k, _ in DISCLOSURES]
    assert req.attestation.device_public_key_spki_b64 == ks.public_key_spki_b64()


@pytest.mark.asyncio
async def test_enroll_posts_and_writes_marker_on_success(agent_cfg, server_signer):
    inp = EnrollmentInput(
        pairing_code="abcdefghijklmnop12345",
        employee_email="jane@firm.example",
        employee_full_name_typed="Jane Q Advisor",
    )
    ks = FileKeyStore(agent_cfg.state_dir / "device.key")
    async with httpx.AsyncClient() as client:
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            route = mock.post("/v1/enroll").respond(
                200,
                json={
                    "server_command_key_id": server_signer["key_id"],
                    "server_command_key_spki_b64": server_signer["spki_b64"],
                },
            )
            status = await enroll(agent_cfg, ks, inp, client)
            assert status == 200
            assert route.called
            body = json.loads(route.calls[0].request.content)
            assert body["pairing_code"] == "abcdefghijklmnop12345"
            assert body["attestation"]["device_id"] == agent_cfg.device_id

    assert (agent_cfg.state_dir / "enrolled").exists()
    assert (agent_cfg.state_dir / "server_command_key.spki.b64").exists()
    assert (
        agent_cfg.state_dir / "server_command_key.id"
    ).read_text() == server_signer["key_id"]


@pytest.mark.asyncio
async def test_enroll_refuses_if_response_missing_server_key(agent_cfg):
    """Old dashboards that return 204 without the command-signing
    public key must not succeed: the agent would be enrolled without
    any way to verify future remediation commands."""
    inp = EnrollmentInput(
        pairing_code="abcdefghijklmnop12345",
        employee_email="jane@firm.example",
        employee_full_name_typed="Jane Q Advisor",
    )
    ks = FileKeyStore(agent_cfg.state_dir / "device.key")
    async with httpx.AsyncClient() as client:
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            mock.post("/v1/enroll").respond(204)
            status = await enroll(agent_cfg, ks, inp, client)
            assert status == 204
    assert not (agent_cfg.state_dir / "enrolled").exists()
    assert not (agent_cfg.state_dir / "server_command_key.spki.b64").exists()


@pytest.mark.asyncio
async def test_enroll_does_not_write_marker_on_failure(agent_cfg):
    inp = EnrollmentInput(
        pairing_code="wrongcodewrongcodee",
        employee_email="jane@firm.example",
        employee_full_name_typed="Jane Q Advisor",
    )
    ks = FileKeyStore(agent_cfg.state_dir / "device.key")
    async with httpx.AsyncClient() as client:
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            mock.post("/v1/enroll").respond(403, text="invalid pairing code")
            status = await enroll(agent_cfg, ks, inp, client)
            assert status == 403
    assert not (agent_cfg.state_dir / "enrolled").exists()
