from __future__ import annotations

import base64
import os
import stat

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from archiveglp_agent.keystore import FileKeyStore


def test_generates_key_on_first_use_with_strict_permissions(tmp_path):
    path = tmp_path / "device.key"
    ks = FileKeyStore(path)
    key = ks.load_or_create()
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    assert path.exists()
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600


def test_subsequent_loads_return_same_key(tmp_path):
    path = tmp_path / "device.key"
    k1 = FileKeyStore(path).load_or_create()

    # New instance, same path: must load the existing key.
    k2 = FileKeyStore(path).load_or_create()

    def to_bytes(k):
        return k.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )

    assert to_bytes(k1) == to_bytes(k2)


def test_spki_is_base64_der_subject_public_key_info(tmp_path):
    ks = FileKeyStore(tmp_path / "device.key")
    spki_b64 = ks.public_key_spki_b64()
    der = base64.b64decode(spki_b64)
    # Round-trip to a usable public key object; exception is the assertion.
    pub = serialization.load_der_public_key(der)
    assert isinstance(pub, ec.EllipticCurvePublicKey)
