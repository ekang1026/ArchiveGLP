import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bodySha256Hex,
  canonicalString,
  FRESHNESS_WINDOW_SECONDS,
  extractSignedHeaders,
  isFresh,
  verifySignature,
} from './signing.js';

function signWithEphemeralKey(body: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const ts = 1745259853;
  const bodyHash = bodySha256Hex(body);
  const canonical = canonicalString('POST', '/v1/ingest', ts, bodyHash);
  const signer = crypto.createSign('sha256');
  signer.update(canonical);
  signer.end();
  const sig = signer.sign({ key: privateKey, dsaEncoding: 'der' });
  const spkiB64 = publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  return { ts, bodyHash, sigB64: sig.toString('base64'), spkiB64 };
}

describe('canonicalString', () => {
  it('matches the cross-language wire format', () => {
    expect(canonicalString('POST', '/v1/ingest', 1745259853, 'abc123').toString()).toBe(
      'POST\n/v1/ingest\n1745259853\nabc123',
    );
  });
});

describe('bodySha256Hex', () => {
  it('hashes the empty string to the well-known constant', () => {
    expect(bodySha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('verifySignature', () => {
  it('accepts a valid signature over the canonical string', () => {
    const body = '{"hello":"world"}';
    const { ts, bodyHash, sigB64, spkiB64 } = signWithEphemeralKey(body);
    expect(verifySignature(spkiB64, 'POST', '/v1/ingest', ts, bodyHash, sigB64)).toBe(true);
  });

  it('rejects a signature over a different body', () => {
    const { ts, sigB64, spkiB64 } = signWithEphemeralKey('{"a":1}');
    const wrongHash = bodySha256Hex('{"a":2}');
    expect(verifySignature(spkiB64, 'POST', '/v1/ingest', ts, wrongHash, sigB64)).toBe(false);
  });

  it('rejects a signature under a different public key', () => {
    const { ts, bodyHash, sigB64 } = signWithEphemeralKey('x');
    const { publicKey: otherPub } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const otherSpki = otherPub.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(verifySignature(otherSpki, 'POST', '/v1/ingest', ts, bodyHash, sigB64)).toBe(false);
  });
});

describe('isFresh', () => {
  it('accepts within the window', () => {
    const now = new Date('2026-04-21T18:04:13Z');
    expect(isFresh(Math.floor(now.getTime() / 1000) - 60, now)).toBe(true);
  });
  it('rejects outside the window', () => {
    const now = new Date('2026-04-21T18:04:13Z');
    expect(isFresh(Math.floor(now.getTime() / 1000) - FRESHNESS_WINDOW_SECONDS - 1, now)).toBe(
      false,
    );
  });
});

describe('extractSignedHeaders', () => {
  it('reads the canonical lower-cased header set', () => {
    const r = extractSignedHeaders({
      'x-archiveglp-device': 'dev_abcdef12',
      'x-archiveglp-timestamp': '1745259853',
      'x-archiveglp-body-sha256': 'abc',
      'x-archiveglp-signature': 'c2ln',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.deviceId).toBe('dev_abcdef12');
  });
  it('reports missing headers', () => {
    const r = extractSignedHeaders({});
    expect(r.ok).toBe(false);
  });
});
