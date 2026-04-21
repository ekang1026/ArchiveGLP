"""Request signing for agent -> API.

Canonical string (v1):

    METHOD\\n
    PATH\\n
    TIMESTAMP\\n
    BODY_SHA256_HEX

Where TIMESTAMP is Unix epoch seconds as a decimal string. The signature
is ECDSA P-256 over SHA-256, DER-encoded, base64.

Headers sent on every authed request:
    X-ArchiveGLP-Device: dev_<id>
    X-ArchiveGLP-Timestamp: <unix_seconds>
    X-ArchiveGLP-Body-Sha256: <hex>
    X-ArchiveGLP-Signature: <base64-der>

The authorizer verifies (1) timestamp freshness (<=5 min) and (2) the
signature against the device's stored public key. The downstream handler
separately verifies that the claimed body hash matches the actual body
(the authorizer cannot see the body).

Any change to this string format is a breaking protocol change and
requires bumping the header prefix (X-ArchiveGLP-Signature-V2) so old
clients fail cleanly instead of silently mis-signing.
"""

from __future__ import annotations

import base64
import hashlib
import time
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec


def body_sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical_string(method: str, path: str, timestamp: int, body_sha256: str) -> bytes:
    return f"{method.upper()}\n{path}\n{timestamp}\n{body_sha256}".encode()


@dataclass(frozen=True)
class SignedHeaders:
    device: str
    timestamp: str
    body_sha256: str
    signature: str

    def as_dict(self) -> dict[str, str]:
        return {
            "X-ArchiveGLP-Device": self.device,
            "X-ArchiveGLP-Timestamp": self.timestamp,
            "X-ArchiveGLP-Body-Sha256": self.body_sha256,
            "X-ArchiveGLP-Signature": self.signature,
        }


def sign_request(
    key: ec.EllipticCurvePrivateKey,
    device_id: str,
    method: str,
    path: str,
    body: bytes,
    now: int | None = None,
) -> SignedHeaders:
    ts = now if now is not None else int(time.time())
    body_hex = body_sha256_hex(body)
    canonical = canonical_string(method, path, ts, body_hex)
    der_sig = key.sign(canonical, ec.ECDSA(hashes.SHA256()))
    return SignedHeaders(
        device=device_id,
        timestamp=str(ts),
        body_sha256=body_hex,
        signature=base64.b64encode(der_sig).decode("ascii"),
    )
