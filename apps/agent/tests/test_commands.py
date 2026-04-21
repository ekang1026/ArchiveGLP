from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
import respx

from archiveglp_agent.checkpoint import State
from archiveglp_agent.commands import CommandExecutor
from archiveglp_agent.pump import CapturePump


def _fresh_state(cfg):
    return State(cfg.state_dir / "agent.sqlite")


def _signed(server_signer, cfg, command_id: str, action: str, parameters=None):
    return server_signer["sign"](
        command_id=command_id,
        device_id=cfg.device_id,
        action=action,
        parameters=parameters,
        issued_at=datetime.now(UTC).isoformat(),
    )


def _executor(cfg, state, client, device_key, server_signer):
    return CommandExecutor(
        cfg, state, client, device_key, server_key=server_signer["server_key"],
    )


@pytest.mark.asyncio
async def test_resync_rewinds_checkpoint(agent_cfg, device_key, server_signer):
    state = _fresh_state(agent_cfg)
    CapturePump(agent_cfg, state).tick()
    # After tick, checkpoint advanced to last processed rowid (>=2).
    assert state.get_last_rowid() > 0
    before = state.get_last_rowid()

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as mock:
            ack = mock.post("/v1/commands").respond(204)
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-000000000001", "resync"),
            )
            assert ack.called
    assert state.get_last_rowid() == 0
    assert before > 0
    state.close()


@pytest.mark.asyncio
async def test_pause_sets_marker_and_pump_skips(agent_cfg, device_key, server_signer):
    state = _fresh_state(agent_cfg)

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-000000000002", "pause"),
            )

    paused = agent_cfg.state_dir / "paused"
    assert paused.exists()

    pump = CapturePump(agent_cfg, state)
    assert pump.tick() == 0
    assert state.queue_depth() == 0
    state.close()


@pytest.mark.asyncio
async def test_resume_clears_marker(agent_cfg, device_key, server_signer):
    state = _fresh_state(agent_cfg)
    paused = agent_cfg.state_dir / "paused"
    paused.parent.mkdir(parents=True, exist_ok=True)
    paused.touch()

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-000000000003", "resume"),
            )
    assert not paused.exists()
    state.close()


@pytest.mark.asyncio
async def test_unknown_action_acks_with_error(agent_cfg, device_key, server_signer):
    state = _fresh_state(agent_cfg)
    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            route = m.post("/v1/commands").respond(204)
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-000000000004", "self-destruct"),
            )
            assert route.called
            posted_body = route.calls[0].request.content
    assert b"unknown action" in posted_body
    state.close()


@pytest.mark.asyncio
async def test_revoke_wipes_state_and_raises_system_exit(
    agent_cfg, device_key, server_signer,
):
    state = _fresh_state(agent_cfg)
    assert agent_cfg.state_dir.exists()

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            with pytest.raises(SystemExit) as exc:
                await cmd.execute(
                    _signed(server_signer, agent_cfg,
                            "00000000-0000-0000-0000-000000000005", "revoke"),
                )
            assert exc.value.code == 0

    # Entire state directory is gone.
    assert not agent_cfg.state_dir.exists()


@pytest.mark.asyncio
async def test_restart_agent_acks_then_execvps(
    agent_cfg, device_key, server_signer, monkeypatch,
):
    state = _fresh_state(agent_cfg)
    execv_calls: list[tuple[str, list[str]]] = []

    def fake_execvp(prog: str, argv: list[str]) -> None:
        execv_calls.append((prog, list(argv)))

    monkeypatch.setattr("archiveglp_agent.commands.os.execvp", fake_execvp)

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-000000000006", "restart_agent"),
            )
            assert ack.called
            assert b'"restarting":true' in ack.calls[0].request.content
    assert len(execv_calls) == 1
    state.close()


@pytest.mark.asyncio
async def test_restart_machine_acks_then_runs_osascript_and_exits(
    agent_cfg, device_key, server_signer, monkeypatch,
):
    import subprocess as _sp

    state = _fresh_state(agent_cfg)
    run_calls: list[list[str]] = []

    class FakeCompleted:
        returncode = 0
        stderr = ""
        stdout = ""

    def fake_run(args, **kwargs):  # noqa: ANN001, ANN003
        run_calls.append(list(args))
        return FakeCompleted()

    monkeypatch.setattr("archiveglp_agent.commands.subprocess.run", fake_run)

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            with pytest.raises(SystemExit) as exc:
                await cmd.execute(
                    _signed(server_signer, agent_cfg,
                            "00000000-0000-0000-0000-000000000007",
                            "restart_machine"),
                )
            assert exc.value.code == 0
            assert ack.called
            assert b'"restart_requested":true' in ack.calls[0].request.content

    assert len(run_calls) == 1
    assert run_calls[0][0] == "/usr/bin/osascript"
    assert "restart" in " ".join(run_calls[0])
    state.close()
    _ = _sp  # keep reference; subprocess import used for type pinning above


@pytest.mark.asyncio
async def test_restart_machine_osascript_failure_is_reported(
    agent_cfg, device_key, server_signer, monkeypatch,
):
    state = _fresh_state(agent_cfg)

    class FakeCompleted:
        returncode = 1
        stderr = "boom"
        stdout = ""

    def fake_run(args, **kwargs):  # noqa: ANN001, ANN003
        return FakeCompleted()

    monkeypatch.setattr("archiveglp_agent.commands.subprocess.run", fake_run)

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        posted: list[bytes] = []
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            route = m.post("/v1/commands").respond(204)
            # Does NOT raise SystemExit — we fall into the generic
            # exception handler that acks with {error: ...}.
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-000000000008",
                        "restart_machine"),
            )
            posted = [c.request.content for c in route.calls]
    # First ack is "restart_requested: true"; second ack is the error
    # from the raised RuntimeError after osascript rc != 0.
    assert any(b"restart_requested" in p for p in posted)
    assert any(b"boom" in p for p in posted)
    state.close()


@pytest.mark.asyncio
async def test_replay_suppresses_side_effects_but_still_acks(
    agent_cfg, device_key, server_signer,
):
    """Server redelivers commands whose ack was lost. Agent must not re-run."""
    state = _fresh_state(agent_cfg)

    first = _signed(
        server_signer, agent_cfg,
        "00000000-0000-0000-0000-0000000000aa", "pause",
    )

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)

        # First delivery: pause runs and creates the marker.
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            await cmd.execute(first)
        paused = agent_cfg.state_dir / "paused"
        assert paused.exists()

        # Between deliveries, user manually resumes so we can tell if
        # the replay re-applies the pause side-effect. (It must not.)
        paused.unlink()

        # Redelivery of the same command_id: ack must fire but marker
        # must stay absent.
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(first)
            assert ack.called, "replay should still ack so server can close the loop"
        assert not paused.exists(), "replay must not re-apply side-effect"
    state.close()


@pytest.mark.asyncio
async def test_replay_of_restart_machine_does_not_reboot_twice(
    agent_cfg, device_key, server_signer, monkeypatch,
):
    state = _fresh_state(agent_cfg)
    run_calls: list[list[str]] = []

    class FakeCompleted:
        returncode = 0
        stderr = ""
        stdout = ""

    def fake_run(args, **kwargs):  # noqa: ANN001, ANN003
        run_calls.append(list(args))
        return FakeCompleted()

    monkeypatch.setattr("archiveglp_agent.commands.subprocess.run", fake_run)

    signed_reboot = _signed(
        server_signer, agent_cfg,
        "00000000-0000-0000-0000-0000000000bb", "restart_machine",
    )

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)

        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            with pytest.raises(SystemExit):
                await cmd.execute(signed_reboot)
        assert len(run_calls) == 1

        # Simulate post-reboot redelivery (ack was "lost" from server's
        # perspective): executor sees the same command id again. Must
        # NOT reboot again — this is the infinite-reboot prevention.
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(signed_reboot)
            assert ack.called
        assert len(run_calls) == 1, "osascript must not run on replay"
    state.close()


@pytest.mark.asyncio
async def test_rejects_command_without_signature(agent_cfg, device_key, server_signer):
    state = _fresh_state(agent_cfg)
    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            # Unsigned command shape — what a MITM would inject.
            await cmd.execute(
                {"command_id": "00000000-0000-0000-0000-0000000000c1",
                 "action": "revoke"},
            )
            assert ack.called
            assert b"missing signature" in ack.calls[0].request.content
    # State dir must NOT have been wiped.
    assert agent_cfg.state_dir.exists()
    state.close()


@pytest.mark.asyncio
async def test_rejects_command_with_bad_signature(
    agent_cfg, device_key, server_signer,
):
    state = _fresh_state(agent_cfg)
    signed = _signed(
        server_signer, agent_cfg,
        "00000000-0000-0000-0000-0000000000c2", "revoke",
    )
    # Tamper with the action post-signing. The signature now covers
    # "pause" but the payload claims "revoke" — attacker's promotion.
    tampered = {**signed, "action": "revoke"}
    # Ensure the signature was actually over a different action so
    # the test proves what it claims to prove.
    legit_revoke = _signed(
        server_signer, agent_cfg,
        "00000000-0000-0000-0000-0000000000c2", "revoke",
    )
    tampered["signature_b64"] = _signed(
        server_signer, agent_cfg,
        "00000000-0000-0000-0000-0000000000c2", "pause",
    )["signature_b64"]

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(tampered)
            assert ack.called
            assert b"bad command signature" in ack.calls[0].request.content
    assert agent_cfg.state_dir.exists()  # state not wiped
    # Sanity: the properly-signed revoke would have wiped it.
    _ = legit_revoke
    state.close()


@pytest.mark.asyncio
async def test_rejects_command_from_wrong_key_id(
    agent_cfg, device_key, server_signer,
):
    state = _fresh_state(agent_cfg)
    signed = _signed(
        server_signer, agent_cfg,
        "00000000-0000-0000-0000-0000000000c3", "pause",
    )
    signed["key_id"] = "attacker-key"
    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(signed)
            assert ack.called
            assert b"bad command signature" in ack.calls[0].request.content
    paused = agent_cfg.state_dir / "paused"
    assert not paused.exists()
    state.close()


@pytest.mark.asyncio
async def test_rejects_command_for_different_device_id(
    agent_cfg, device_key, server_signer,
):
    state = _fresh_state(agent_cfg)
    signed = server_signer["sign"](
        command_id="00000000-0000-0000-0000-0000000000c4",
        device_id="dev_someoneelse",
        action="revoke",
        parameters=None,
        issued_at=datetime.now(UTC).isoformat(),
    )
    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(signed)
            assert ack.called
            assert b"device_id mismatch" in ack.calls[0].request.content
    assert agent_cfg.state_dir.exists()
    state.close()


@pytest.mark.asyncio
async def test_diagnose_returns_structured_snapshot(
    agent_cfg, device_key, server_signer, monkeypatch,
):
    """diagnose should never fail the whole command even if probes err."""
    state = _fresh_state(agent_cfg)

    class FakeCompleted:
        returncode = 0
        stdout = "1234\n"
        stderr = ""

    def fake_run(args, **kwargs):  # noqa: ANN001, ANN003
        return FakeCompleted()

    monkeypatch.setattr("archiveglp_agent.commands.subprocess.run", fake_run)

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            route = m.post("/v1/commands").respond(204)
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-0000000000d1", "diagnose"),
            )
            posted = route.calls[0].request.content
    # Snapshot includes at least queue_depth, last_rowid, paused, and
    # the agent_version — regardless of Messages.app probe outcome.
    assert b'"queue_depth"' in posted
    assert b'"last_rowid"' in posted
    assert b'"paused"' in posted
    assert b'"agent_version"' in posted
    state.close()


@pytest.mark.asyncio
async def test_diagnose_has_no_side_effects_on_state(
    agent_cfg, device_key, server_signer, monkeypatch,
):
    """Diagnose must not pause, resync, or mutate anything."""
    state = _fresh_state(agent_cfg)
    before_rowid = state.get_last_rowid()

    def fake_run(args, **kwargs):  # noqa: ANN001, ANN003
        class R:
            returncode = 1  # pgrep no-match
            stdout = ""
            stderr = ""

        return R()

    monkeypatch.setattr("archiveglp_agent.commands.subprocess.run", fake_run)

    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            await cmd.execute(
                _signed(server_signer, agent_cfg,
                        "00000000-0000-0000-0000-0000000000d2", "diagnose"),
            )
    assert state.get_last_rowid() == before_rowid
    assert not (agent_cfg.state_dir / "paused").exists()
    state.close()


@pytest.mark.asyncio
async def test_poll_returns_commands_list(agent_cfg, device_key, server_signer):
    state = _fresh_state(agent_cfg)
    async with httpx.AsyncClient() as client:
        cmd = _executor(agent_cfg, state, client, device_key, server_signer)
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
