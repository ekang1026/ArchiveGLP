from __future__ import annotations

import base64

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from archiveglp_agent.signing import body_sha256_hex, canonical_string, sign_request


def test_canonical_string_is_stable_and_includes_all_fields():
    s = canonical_string("POST", "/v1/ingest", 1745259853, "abc123")
    assert s == b"POST\n/v1/ingest\n1745259853\nabc123"


def test_body_sha256_hex_matches_known_value():
    # sha256 of empty string is the well-known constant.
    assert (
        body_sha256_hex(b"")
        == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )


def test_signed_headers_verify_against_public_key():
    key = ec.generate_private_key(ec.SECP256R1())
    signed = sign_request(
        key,
        device_id="dev_abc12345",
        method="POST",
        path="/v1/ingest",
        body=b'{"hello":"world"}',
        now=1745259853,
    )
    # Headers present and well-formed.
    d = signed.as_dict()
    assert d["X-ArchiveGLP-Device"] == "dev_abc12345"
    assert d["X-ArchiveGLP-Timestamp"] == "1745259853"
    assert d["X-ArchiveGLP-Body-Sha256"] == body_sha256_hex(b'{"hello":"world"}')
    assert d["X-ArchiveGLP-Signature"]

    # Signature verifies against the public key.
    pub = key.public_key()
    pub.verify(
        base64.b64decode(d["X-ArchiveGLP-Signature"]),
        canonical_string("POST", "/v1/ingest", 1745259853, d["X-ArchiveGLP-Body-Sha256"]),
        ec.ECDSA(hashes.SHA256()),
    )

    # Serializing/loading the public key round-trips (sanity for spki path).
    der = pub.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    loaded = serialization.load_der_public_key(der)
    assert isinstance(loaded, ec.EllipticCurvePublicKey)
