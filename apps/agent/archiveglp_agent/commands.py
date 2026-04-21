"""Poll /v1/commands for server-issued actions and execute them locally.

The dashboard issues control-plane commands by inserting rows into
the pending_command table. This module fetches ready commands (GET
/v1/commands), executes each, and acks (POST /v1/commands) with a
result or error. On each tick we:

  1. Sign + GET /v1/commands.
  2. For each command, dispatch by action name.
  3. Sign + POST /v1/commands with {command_id, result|error}.

Supported actions in the MVP:

  diagnose        Cheap, read-only probe: chat.db mtime + size, Messages.app
                  process running, queue depth, last processed rowid, FDA /
                  pause state. Returns the snapshot in `result` so the
                  supervisor can see at a glance why the device looks
                  "silent" (heartbeat fresh but no captures). No side effects.
  resync          Reset the pump checkpoint so the agent re-reads all
                  chat.db rows from the beginning. Used when a supervisor
                  wants to force re-capture after fixing a decoding bug.
  pause           Stop the pump from enqueueing new messages. Heartbeats
                  continue so the dashboard still sees the device.
  resume          Clear pause state.
  revoke          Delete the device private key, enrollment marker, and
                  outbound queue, then exit the process. The device is
                  effectively de-enrolled.
  restart_agent   Ack, then re-exec the agent process in place. Under
                  launchd the PID persists; manually run, the shell
                  process is replaced. Either way all in-memory state
                  (pending queues, SQLite handles) is reset.
  restart_machine Ack, then shell out to `osascript` to reboot macOS.
                  Runs as the logged-in user — no sudo, no admin creds.
                  After reboot, the user must log in again at the
                  loginwindow (FileVault + no auto-login by design).
                  Supervisor can VNC in over Tailscale to perform that
                  login without employee presence.
  rotate_key      Not yet implemented. Returns an error.
  upgrade         Not yet implemented. Returns an error.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import structlog
from cryptography.hazmat.primitives.asymmetric import ec

from .checkpoint import State
from .config import AgentConfig
from .server_key import ServerCommandKey, load_server_key
from .signing import sign_request

log = structlog.get_logger(__name__)

_POLL_PATH = "/v1/commands"
_ACK_PATH = "/v1/commands"


class CommandExecutor:
    def __init__(
        self,
        cfg: AgentConfig,
        state: State,
        client: httpx.AsyncClient,
        private_key: ec.EllipticCurvePrivateKey,
        server_key: ServerCommandKey | None = None,
    ) -> None:
        self._cfg = cfg
        self._state = state
        self._client = client
        self._key = private_key
        self._url = cfg.api_base_url.rstrip("/") + _POLL_PATH
        # Paused state is held in-memory and on disk so it survives
        # restarts. The pump checks `cfg.state_dir / "paused"`.
        self._paused_marker = cfg.state_dir / "paused"
        # Server signing key. If None we load it lazily from state
        # dir. If still missing we fail-closed on every command.
        self._server_key = server_key if server_key is not None else load_server_key(cfg.state_dir)

    async def _signed(self, method: str, path: str, body: bytes) -> dict[str, str]:
        signed = sign_request(
            self._key,
            device_id=self._cfg.device_id,
            method=method,
            path=path,
            body=body,
        )
        return {"content-type": "application/json", **signed.as_dict()}

    async def poll(self) -> list[dict[str, Any]]:
        try:
            resp = await self._client.get(
                self._url,
                headers=await self._signed("GET", _POLL_PATH, b""),
                timeout=15,
            )
        except httpx.HTTPError as exc:
            log.warning("commands.poll_network_error", error=str(exc))
            return []
        if resp.status_code // 100 != 2:
            log.warning("commands.poll_http_error", status=resp.status_code, body=resp.text[:200])
            return []
        data = resp.json()
        commands = data.get("commands") or []
        return list(commands)

    async def ack(self, command_id: str, *, result: dict[str, Any] | None = None, error: str | None = None) -> None:
        body_obj: dict[str, Any] = {"command_id": command_id}
        if result is not None:
            body_obj["result"] = result
        if error is not None:
            body_obj["error"] = error
        body = json.dumps(body_obj, separators=(",", ":")).encode("utf-8")
        try:
            await self._client.post(
                self._url,
                content=body,
                headers=await self._signed("POST", _ACK_PATH, body),
                timeout=15,
            )
        except httpx.HTTPError as exc:
            log.warning("commands.ack_network_error", error=str(exc))

    def is_paused(self) -> bool:
        return self._paused_marker.exists()

    # ---- Action handlers ----

    def _do_resync(self) -> dict[str, Any]:
        self._state.set_last_rowid(0)
        log.info("commands.resync.done")
        return {"checkpoint_reset_to": 0}

    def _do_pause(self) -> dict[str, Any]:
        self._paused_marker.parent.mkdir(parents=True, exist_ok=True)
        self._paused_marker.touch()
        log.info("commands.pause.done")
        return {"paused": True}

    def _do_resume(self) -> dict[str, Any]:
        if self._paused_marker.exists():
            self._paused_marker.unlink()
        log.info("commands.resume.done")
        return {"paused": False}

    def _do_revoke(self) -> dict[str, Any]:
        # Wipe everything the agent persists. Next start requires re-enroll.
        state_dir = self._cfg.state_dir
        if state_dir.exists():
            shutil.rmtree(state_dir, ignore_errors=True)
        log.warning("commands.revoke.done", state_dir=str(state_dir))
        return {"revoked": True}

    def _do_diagnose(self) -> dict[str, Any]:
        """Cheap, read-only snapshot for supervisor-visible debugging.

        Invoked when the dashboard flags the device as "silent" (heartbeat
        fresh but last_captured_at stale). Each check is best-effort and
        wrapped; one broken probe doesn't poison the whole report.
        """
        result: dict[str, Any] = {}

        # chat.db existence + mtime. If the file vanished or can't be
        # stat'd (sandbox, FDA revoked) that's directly actionable.
        try:
            st = self._cfg.chatdb_path.stat()
            result["chatdb_exists"] = True
            result["chatdb_mtime"] = st.st_mtime
            result["chatdb_size_bytes"] = st.st_size
        except FileNotFoundError:
            result["chatdb_exists"] = False
        except PermissionError as exc:
            result["chatdb_exists"] = True
            result["chatdb_permission_error"] = str(exc)

        # Messages.app process. `pgrep -x Messages` returns 0 if one
        # match; 1 if none; 2 on syntax error. We only care about
        # presence. Short timeout so a hung launchd doesn't block.
        try:
            completed = subprocess.run(
                ["/usr/bin/pgrep", "-x", "Messages"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            result["messages_app_running"] = completed.returncode == 0
            if completed.returncode == 0:
                result["messages_app_pids"] = [
                    int(p) for p in completed.stdout.split() if p.strip().isdigit()
                ]
        except (OSError, subprocess.SubprocessError) as exc:
            result["messages_app_probe_error"] = str(exc)

        # Agent-local state: queue depth + last processed rowid. Tells
        # supervisor whether the pump is reading chat.db rows but
        # stalling on upload, vs. not reading at all.
        try:
            result["queue_depth"] = self._state.queue_depth()
            result["last_rowid"] = self._state.get_last_rowid()
        except Exception as exc:  # noqa: BLE001
            result["state_probe_error"] = str(exc)

        result["paused"] = self._paused_marker.exists()
        result["agent_version"] = self._cfg.agent_version

        log.info("commands.diagnose.done", result=result)
        return result

    def _do_restart_machine(self) -> dict[str, Any]:
        # No sudo, no admin. Works because osascript driving System
        # Events is privileged enough to request a restart for the
        # current user session. macOS will tear down apps cleanly.
        script = 'tell application "System Events" to restart'
        completed = subprocess.run(
            ["/usr/bin/osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"osascript restart failed (rc={completed.returncode}): "
                f"{completed.stderr.strip()}"
            )
        log.warning("commands.restart_machine.requested")
        return {"restart_requested": True}

    async def execute(self, command: dict[str, Any]) -> None:
        cid = str(command.get("command_id", ""))
        action = str(command.get("action", ""))
        log.info("commands.execute", command_id=cid, action=action)

        # Verify the server's signature over the command payload
        # before anything else. Fails closed on missing key, missing
        # signature, wrong key_id, or bad signature. We ack with an
        # error so the server can flag it — but we never dispatch.
        sig_b64 = command.get("signature_b64")
        sig_key_id = command.get("key_id")
        issued_at = command.get("issued_at")
        cmd_device_id = command.get("device_id")
        if self._server_key is None:
            log.error("commands.reject.no_server_key", command_id=cid)
            if cid:
                await self.ack(cid, error="agent has no server command key on file")
            return
        if not sig_b64 or not sig_key_id or not issued_at or not cmd_device_id:
            log.error("commands.reject.missing_signature_fields", command_id=cid)
            if cid:
                await self.ack(cid, error="command missing signature fields")
            return
        if cmd_device_id != self._cfg.device_id:
            log.error(
                "commands.reject.device_id_mismatch",
                command_id=cid,
                claimed=cmd_device_id,
            )
            if cid:
                await self.ack(cid, error="command device_id mismatch")
            return
        ok = self._server_key.verify(
            command_id=cid,
            device_id=cmd_device_id,
            action=action,
            parameters=command.get("parameters"),
            issued_at=str(issued_at),
            signature_b64=str(sig_b64),
            key_id=str(sig_key_id),
        )
        if not ok:
            log.error(
                "commands.reject.bad_signature",
                command_id=cid,
                action=action,
                key_id=sig_key_id,
            )
            if cid:
                await self.ack(cid, error="bad command signature")
            return

        # Idempotency: server may re-deliver commands whose acks were
        # lost. If we already ran this one, re-ack (so the server can
        # close the loop) but skip side-effects. The replayed ack uses
        # whatever result/error we recorded originally, so the
        # supervisor-visible row stays stable.
        prior = self._state.was_command_executed(cid) if cid else None
        if prior is not None:
            log.info("commands.replay_suppressed", command_id=cid, action=action)
            result_json = prior.get("result_json")
            error_text = prior.get("error_text")
            result: dict[str, Any] | None = None
            if result_json:
                try:
                    result = json.loads(result_json)
                except json.JSONDecodeError:
                    result = None
            await self.ack(cid, result=result, error=error_text)
            return

        def _record(
            result: dict[str, Any] | None = None, error: str | None = None
        ) -> None:
            self._state.record_command_executed(
                cid,
                action,
                json.dumps(result) if result is not None else None,
                error,
            )

        try:
            if action == "diagnose":
                result: dict[str, Any] = self._do_diagnose()
            elif action == "resync":
                result = self._do_resync()
            elif action == "pause":
                result = self._do_pause()
            elif action == "resume":
                result = self._do_resume()
            elif action == "revoke":
                # Record BEFORE the destructive side-effect so a post-
                # revoke replay (unlikely: state dir is wiped) would at
                # least not re-wipe — and because record + ack is our
                # canonical "ran it" marker everywhere else.
                _record(result={"revoked": True})
                result = self._do_revoke()
                await self.ack(cid, result=result)
                # After revoke the agent can't sign anything further
                # (state dir is gone including the device key). Raise
                # SystemExit so the run loop terminates cleanly.
                raise SystemExit(0)
            elif action == "restart_agent":
                # Record + ack BEFORE re-exec so the post-restart poll
                # sees the command as already-executed and replay-
                # suppresses it. Without this, a lost ack would cause
                # an infinite re-exec loop on every redelivery cycle.
                _record(result={"restarting": True})
                await self.ack(cid, result={"restarting": True})
                await asyncio.sleep(0.5)
                log.warning(
                    "commands.restart_agent.execing",
                    argv=sys.argv,
                    executable=sys.executable,
                )
                # Replace this process image. Under launchd the PID
                # survives and the service stays "running"; run from
                # a shell, the shell sees a clean handoff.
                os.execvp(sys.argv[0], sys.argv)
                # unreachable
                return
            elif action == "restart_machine":
                # Record + ack FIRST so a lost ack + reboot + redelivery
                # doesn't reboot the machine twice. Without the record
                # the agent would see the redelivered command after
                # boot, execute it, and reboot again — an infinite
                # reboot loop on any device whose first ack was lost.
                _record(result={"restart_requested": True})
                await self.ack(cid, result={"restart_requested": True})
                await asyncio.sleep(1.0)
                self._do_restart_machine()
                # The OS will kill us shortly. Exit cleanly in case
                # the reboot is delayed (e.g. by an open app prompting
                # the user to save).
                raise SystemExit(0)
            elif action in {"rotate_key", "upgrade"}:
                _record(error=f"{action} not implemented")
                await self.ack(cid, error=f"{action} not implemented")
                return
            else:
                _record(error=f"unknown action: {action}")
                await self.ack(cid, error=f"unknown action: {action}")
                return
            _record(result=result)
            await self.ack(cid, result=result)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("commands.execute_failed", command_id=cid, action=action)
            _record(error=str(exc))
            await self.ack(cid, error=str(exc))

    async def run_forever(self, interval_seconds: float = 30.0) -> None:
        while True:
            try:
                commands = await self.poll()
                for cmd in commands:
                    await self.execute(cmd)
            except SystemExit:
                raise
            except Exception:
                log.exception("commands.loop_unhandled")
            await asyncio.sleep(interval_seconds)
