"""Pydantic mirror of packages/schema. Source of truth is the Zod schema.

Keep field names and constraints in sync. A generator could replace this,
but while the schema is small we maintain it by hand to stay readable.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Handle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    handle: str = Field(min_length=1, max_length=256)
    display: str | None = Field(default=None, max_length=256)


class Attachment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    mime: str = Field(max_length=128)
    bytes: int = Field(ge=0)
    filename: str | None = Field(default=None, max_length=512)
    s3_key: str | None = Field(default=None, max_length=1024)


class BodyEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: datetime
    text: str


Direction = Literal["inbound", "outbound"]
Source = Literal["imessage", "sms"]


class Message(BaseModel):
    """Canonical captured message. Agent-side; server fills archive_seq + ingested_at."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    firm_id: str
    employee_id: str
    device_id: str
    source: Source
    conversation_id: str
    message_id: str
    captured_at: datetime
    direction: Direction
    from_: Handle = Field(alias="from")
    to: list[Handle] = Field(min_length=1)
    body_text: str = ""
    body_edits: list[BodyEdit] = Field(default_factory=list)
    unsent: bool = False
    attachments: list[Attachment] = Field(default_factory=list)
    raw_source: dict[str, Any] | None = None


class ClientMessageEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[Message] = Field(min_length=1, max_length=500)
    client_batch_id: str
    client_sig: str


class EnrollmentAttestation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    firm_id: str
    employee_id: str
    device_id: str
    employee_full_name_typed: str
    employee_email: str
    disclosures_version: str
    disclosures_shown: list[str]
    attested_at: datetime
    device_public_key_spki_b64: str
    os_version: str
    agent_version: str


AgentStatus = Literal["healthy", "degraded", "tcc_revoked", "chatdb_unreadable", "offline"]


class Heartbeat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    firm_id: str
    employee_id: str
    device_id: str
    agent_version: str
    os_version: str
    status: AgentStatus
    reported_at: datetime
    last_captured_at: datetime | None
    queue_depth: int = Field(ge=0)
    clock_skew_ms: int
