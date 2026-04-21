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
async def test_restart_agent_acks_then_execvps(agent_cfg, device_key, monkeypatch):
    state = _fresh_state(agent_cfg)
    execv_calls: list[tuple[str, list[str]]] = []

    def fake_execvp(prog: str, argv: list[str]) -> None:
        execv_calls.append((prog, list(argv)))

    monkeypatch.setattr("archiveglp_agent.commands.os.execvp", fake_execvp)

    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(
                {"command_id": "00000000-0000-0000-0000-000000000006", "action": "restart_agent"},
            )
            assert ack.called
            assert b'"restarting":true' in ack.calls[0].request.content
    assert len(execv_calls) == 1
    state.close()


@pytest.mark.asyncio
async def test_restart_machine_acks_then_runs_osascript_and_exits(
    agent_cfg, device_key, monkeypatch,
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
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            with pytest.raises(SystemExit) as exc:
                await cmd.execute(
                    {
                        "command_id": "00000000-0000-0000-0000-000000000007",
                        "action": "restart_machine",
                    },
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
    agent_cfg, device_key, monkeypatch,
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
        cmd = CommandExecutor(agent_cfg, state, client, device_key)
        posted: list[bytes] = []
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            route = m.post("/v1/commands").respond(204)
            # Does NOT raise SystemExit — we fall into the generic
            # exception handler that acks with {error: ...}.
            await cmd.execute(
                {
                    "command_id": "00000000-0000-0000-0000-000000000008",
                    "action": "restart_machine",
                },
            )
            posted = [c.request.content for c in route.calls]
    # First ack is "restart_requested: true"; second ack is the error
    # from the raised RuntimeError after osascript rc != 0.
    assert any(b"restart_requested" in p for p in posted)
    assert any(b"boom" in p for p in posted)
    state.close()


@pytest.mark.asyncio
async def test_replay_suppresses_side_effects_but_still_acks(agent_cfg, device_key):
    """Server redelivers commands whose ack was lost. Agent must not re-run."""
    state = _fresh_state(agent_cfg)

    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)

        # First delivery: pause runs and creates the marker.
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            await cmd.execute(
                {"command_id": "00000000-0000-0000-0000-0000000000aa", "action": "pause"},
            )
        paused = agent_cfg.state_dir / "paused"
        assert paused.exists()

        # Between deliveries, user manually resumes so we can tell if
        # the replay re-applies the pause side-effect. (It must not.)
        paused.unlink()

        # Redelivery of the same command_id: ack must fire but marker
        # must stay absent.
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(
                {"command_id": "00000000-0000-0000-0000-0000000000aa", "action": "pause"},
            )
            assert ack.called, "replay should still ack so server can close the loop"
        assert not paused.exists(), "replay must not re-apply side-effect"
    state.close()


@pytest.mark.asyncio
async def test_replay_of_restart_machine_does_not_reboot_twice(
    agent_cfg, device_key, monkeypatch,
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

    async with httpx.AsyncClient() as client:
        cmd = CommandExecutor(agent_cfg, state, client, device_key)

        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            m.post("/v1/commands").respond(204)
            with pytest.raises(SystemExit):
                await cmd.execute(
                    {
                        "command_id": "00000000-0000-0000-0000-0000000000bb",
                        "action": "restart_machine",
                    },
                )
        assert len(run_calls) == 1

        # Simulate post-reboot redelivery (ack was "lost" from server's
        # perspective): executor sees the same command id again. Must
        # NOT reboot again — this is the infinite-reboot prevention.
        with respx.mock(base_url=agent_cfg.api_base_url) as m:
            ack = m.post("/v1/commands").respond(204)
            await cmd.execute(
                {
                    "command_id": "00000000-0000-0000-0000-0000000000bb",
                    "action": "restart_machine",
                },
            )
            assert ack.called
        assert len(run_calls) == 1, "osascript must not run on replay"
    state.close()


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
