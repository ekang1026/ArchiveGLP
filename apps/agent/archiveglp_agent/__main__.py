"""CLI entrypoint."""

from __future__ import annotations

import asyncio
import sys

import click
import httpx
import structlog

from . import __version__
from .checkpoint import State
from .commands import CommandExecutor
from .config import AgentConfig
from .enroll import DISCLOSURES, EnrollmentInput, enroll
from .forwarder import Forwarder
from .heartbeat import HeartbeatEmitter
from .pump import CapturePump

log = structlog.get_logger(__name__)


def _configure_logging() -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
    )


@click.group()
@click.version_option(__version__)
def main() -> None:
    """ArchiveGLP macOS capture agent."""
    _configure_logging()


@main.command()
def run() -> None:
    """Run capture pump + forwarder. Intended to be launched by launchd."""
    cfg = AgentConfig.from_env()
    state = State(cfg.state_dir / "agent.sqlite")
    pump = CapturePump(cfg, state)
    keystore = cfg.keystore()
    if not (cfg.state_dir / "device.key").exists():
        raise SystemExit(
            "Device not enrolled. Run `archiveglp-agent enroll` first.",
        )
    private_key = keystore.load_or_create()

    async def _go() -> None:
        async with httpx.AsyncClient() as client:
            forwarder = Forwarder(state, cfg.api_base_url, client, cfg.device_id, private_key)
            heartbeat = HeartbeatEmitter(cfg, state, client, private_key)
            commands = CommandExecutor(cfg, state, client, private_key)
            await asyncio.gather(
                pump.run_forever(),
                forwarder.run_forever(cfg.batch_size),
                heartbeat.run_forever(),
                commands.run_forever(),
            )

    try:
        asyncio.run(_go())
    except KeyboardInterrupt:
        log.info("agent.shutdown")
        state.close()
        sys.exit(0)


@main.command("enroll")
@click.option("--pairing-code", prompt="Pairing code from your firm admin")
@click.option("--email", prompt="Your work email")
def enroll_cmd(pairing_code: str, email: str) -> None:
    """First-run device enrollment."""
    cfg = AgentConfig.from_env()
    click.echo("ArchiveGLP will capture the following on this Mac:\n")
    for _, text in DISCLOSURES:
        click.echo(f"  - {text}\n")
    typed = click.prompt(
        "Type your full legal name to attest that you understand and consent",
    )
    inp = EnrollmentInput(
        pairing_code=pairing_code,
        employee_email=email,
        employee_full_name_typed=typed,
    )

    async def _go() -> int:
        async with httpx.AsyncClient() as client:
            return await enroll(cfg, cfg.keystore(), inp, client)

    status = asyncio.run(_go())
    if status // 100 == 2:
        click.echo("Enrollment accepted. You can now start the agent with `run`.")
        sys.exit(0)
    click.echo(f"Enrollment failed with status {status}.", err=True)
    sys.exit(1)


@main.command()
def capture_once() -> None:
    """Run one capture tick. Useful for local dev."""
    cfg = AgentConfig.from_env()
    state = State(cfg.state_dir / "agent.sqlite")
    pump = CapturePump(cfg, state)
    n = pump.tick()
    click.echo(f"enqueued={n} queue_depth={state.queue_depth()}")


if __name__ == "__main__":
    main()
