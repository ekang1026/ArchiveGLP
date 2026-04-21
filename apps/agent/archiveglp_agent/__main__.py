"""CLI entrypoint."""

from __future__ import annotations

import asyncio
import sys

import click
import httpx
import structlog

from . import __version__
from .checkpoint import State
from .config import AgentConfig
from .forwarder import Forwarder
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

    async def _go() -> None:
        async with httpx.AsyncClient() as client:
            forwarder = Forwarder(state, cfg.api_base_url, client)
            await asyncio.gather(pump.run_forever(), forwarder.run_forever(cfg.batch_size))

    try:
        asyncio.run(_go())
    except KeyboardInterrupt:
        log.info("agent.shutdown")
        state.close()
        sys.exit(0)


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
