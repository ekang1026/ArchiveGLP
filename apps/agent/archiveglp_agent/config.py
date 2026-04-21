"""Agent runtime configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _default_chatdb_path() -> Path:
    return Path.home() / "Library" / "Messages" / "chat.db"


def _default_state_dir() -> Path:
    # ~/Library/Application Support/ArchiveGLP on macOS.
    return Path.home() / "Library" / "Application Support" / "ArchiveGLP"


@dataclass(frozen=True)
class AgentConfig:
    firm_id: str
    employee_id: str
    device_id: str
    api_base_url: str
    chatdb_path: Path
    state_dir: Path
    poll_interval_seconds: float
    batch_size: int
    agent_version: str

    @classmethod
    def from_env(cls) -> AgentConfig:
        def _req(name: str) -> str:
            value = os.environ.get(name)
            if not value:
                raise RuntimeError(f"Missing required env var: {name}")
            return value

        return cls(
            firm_id=_req("ARCHIVEGLP_FIRM_ID"),
            employee_id=_req("ARCHIVEGLP_EMPLOYEE_ID"),
            device_id=_req("ARCHIVEGLP_DEVICE_ID"),
            api_base_url=_req("ARCHIVEGLP_API_BASE_URL"),
            chatdb_path=Path(os.environ.get("ARCHIVEGLP_CHATDB_PATH") or _default_chatdb_path()),
            state_dir=Path(os.environ.get("ARCHIVEGLP_STATE_DIR") or _default_state_dir()),
            poll_interval_seconds=float(os.environ.get("ARCHIVEGLP_POLL_SECONDS", "5")),
            batch_size=int(os.environ.get("ARCHIVEGLP_BATCH_SIZE", "100")),
            agent_version=os.environ.get("ARCHIVEGLP_AGENT_VERSION", "0.0.1-dev"),
        )
