"""Verification of server-issued remediation commands.

The server signs each `pending_command` row with its backend ECDSA
P-256 private key. This module loads the cached public key + key_id
from the agent state dir, verifies signatures over the canonical
string format, and refuses any command that doesn't carry a valid
signature from the expected key_id.

This is the sole defense against a MITM injecting `revoke` /
`restart_machine` into a poll response body. TLS authenticates the
host; signed commands authenticate the content.

Canonical string format (must stay in lockstep with
`apps/dashboard/lib/command-signing.ts`):

    {key_id}\n
    {command_id}\n
    {device_id}\n
    {action}\n
    {parameters_canonical}\n
    {issued_at_epoch_seconds}

`parameters_canonical` is either the empty string (for null/missing
parameters) or the JSON encoding with keys sorted at every nesting
level, no whitespace.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

_KEY_FILE = "server_command_key.spki.b64"
_KEY_ID_FILE = "server_command_key.id"


def _sorted_json(v: Any) -> str:
    if v is None:
        return ""
    # separators=(",",":") + sort_keys=True yields canonical JSON.
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def canonical_command_string(
    key_id: str,
    command_id: str,
    device_id: str,
    action: str,
    parameters: Any,
    issued_at: str,
) -> bytes:
    ts = int(datetime.fromisoformat(issued_at.replace("Z", "+00:00")).timestamp())
    params = _sorted_json(parameters)
    return f"{key_id}\n{command_id}\n{device_id}\n{action}\n{params}\n{ts}".encode()


@dataclass
class ServerCommandKey:
    key_id: str
    public_key: ec.EllipticCurvePublicKey

    def verify(
        self,
        *,
        command_id: str,
        device_id: str,
        action: str,
        parameters: Any,
        issued_at: str,
        signature_b64: str,
        key_id: str,
    ) -> bool:
        if key_id != self.key_id:
            return False
        canonical = canonical_command_string(
            self.key_id, command_id, device_id, action, parameters, issued_at
        )
        sig = base64.b64decode(signature_b64)
        try:
            self.public_key.verify(sig, canonical, ec.ECDSA(hashes.SHA256()))
        except InvalidSignature:
            return False
        return True


def persist_server_key(state_dir: Path, key_id: str, spki_b64: str) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / _KEY_FILE).write_text(spki_b64)
    (state_dir / _KEY_ID_FILE).write_text(key_id)


def load_server_key(state_dir: Path) -> ServerCommandKey | None:
    key_path = state_dir / _KEY_FILE
    id_path = state_dir / _KEY_ID_FILE
    if not key_path.exists() or not id_path.exists():
        return None
    spki_b64 = key_path.read_text().strip()
    key_id = id_path.read_text().strip()
    spki_der = base64.b64decode(spki_b64)
    pub = serialization.load_der_public_key(spki_der)
    if not isinstance(pub, ec.EllipticCurvePublicKey):
        raise ValueError("server command key is not an EC public key")
    return ServerCommandKey(key_id=key_id, public_key=pub)
