"""Poll /v1/commands for server-issued actions and execute them locally.

The dashboard issues control-plane commands by inserting rows into
the pending_command table. This module fetches ready commands (GET
/v1/commands), executes each, and acks (POST /v1/commands) with a
result or error. On each tick we:

  1. Sign + GET /v1/commands.
  2. For each command, dispatch by action name.
  3. Sign + POST /v1/commands with {command_id, result|error}.

Supported actions in the MVP:

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
    ) -> None:
        self._cfg = cfg
        self._state = state
        self._client = client
        self._key = private_key
        self._url = cfg.api_base_url.rstrip("/") + _POLL_PATH
        # Paused state is held in-memory and on disk so it survives
        # restarts. The pump checks `cfg.state_dir / "paused"`.
        self._paused_marker = cfg.state_dir / "paused"

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
        try:
            if action == "resync":
                result: dict[str, Any] = self._do_resync()
            elif action == "pause":
                result = self._do_pause()
            elif action == "resume":
                result = self._do_resume()
            elif action == "revoke":
                result = self._do_revoke()
                await self.ack(cid, result=result)
                # After revoke the agent can't sign anything further
                # (state dir is gone including the device key). Raise
                # SystemExit so the run loop terminates cleanly.
                raise SystemExit(0)
            elif action == "restart_agent":
                # Ack BEFORE re-exec: after os.execv the Python
                # interpreter is replaced and any pending HTTP
                # response would be dropped on the floor. Give the
                # TCP write a brief moment to flush.
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
                # Ack FIRST so the dashboard records the command as
                # accepted. The reboot itself is asynchronous — macOS
                # will begin shutdown after osascript returns.
                await self.ack(cid, result={"restart_requested": True})
                await asyncio.sleep(1.0)
                self._do_restart_machine()
                # The OS will kill us shortly. Exit cleanly in case
                # the reboot is delayed (e.g. by an open app prompting
                # the user to save).
                raise SystemExit(0)
            elif action in {"rotate_key", "upgrade"}:
                await self.ack(cid, error=f"{action} not implemented")
                return
            else:
                await self.ack(cid, error=f"unknown action: {action}")
                return
            await self.ack(cid, result=result)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("commands.execute_failed", command_id=cid, action=action)
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
