"""Device keypair storage.

For MVP we persist an ECDSA P-256 private key to a file under the agent's
state directory with 0600 permissions. On macOS this lives inside
`~/Library/Application Support/ArchiveGLP/`, which already sits inside
the user's home directory and is readable only by them.

The interface is deliberately small (`KeyStore`) so a production build
can swap in a Secure Enclave / Keychain backend without touching the
agent's signing call sites. `SecureEnclaveKeyStore` is a v2 item; the
FileKeyStore ships first because it's testable cross-platform and it
still gives us defense-in-depth (TLS + signed requests + server-side
public key match) - what we lose is hardware-backed key non-extractability.
"""

from __future__ import annotations

import base64
import os
from abc import ABC, abstractmethod
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

_CURVE = ec.SECP256R1()


class KeyStore(ABC):
    @abstractmethod
    def load_or_create(self) -> ec.EllipticCurvePrivateKey:
        """Return the device private key, creating it on first use."""

    @abstractmethod
    def public_key_spki_b64(self) -> str:
        """Return the SPKI-encoded (DER, base64) public key for registration."""


class FileKeyStore(KeyStore):
    """Persists the device keypair to a single PEM file, mode 0600."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._key: ec.EllipticCurvePrivateKey | None = None

    def load_or_create(self) -> ec.EllipticCurvePrivateKey:
        if self._key is not None:
            return self._key
        if self._path.exists():
            data = self._path.read_bytes()
            loaded = serialization.load_pem_private_key(data, password=None)
            if not isinstance(loaded, ec.EllipticCurvePrivateKey):
                raise RuntimeError(f"Unexpected key type in {self._path}")
            self._key = loaded
            return self._key

        self._path.parent.mkdir(parents=True, exist_ok=True)
        key = ec.generate_private_key(_CURVE)
        pem = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        # Write then chmod so there's no moment where the file has loose
        # permissions. os.O_EXCL so we never clobber an existing key.
        fd = os.open(str(self._path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, pem)
        finally:
            os.close(fd)
        self._key = key
        return key

    def public_key_spki_b64(self) -> str:
        key = self.load_or_create()
        spki = key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return base64.b64encode(spki).decode("ascii")
