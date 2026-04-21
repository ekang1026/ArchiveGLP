import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetForTests,
  canonicalCommandString,
  loadCommandSigner,
} from './command-signing';

function generateKeyMaterial(): { keyIdEnv: string; privateKeyB64: string } {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    keyIdEnv: 'test-key-1',
    privateKeyB64: pkcs8.toString('base64'),
  };
}

describe('canonicalCommandString', () => {
  it('is stable and sorts parameter keys', () => {
    const a = canonicalCommandString('k1', {
      command_id: 'cid',
      device_id: 'dev',
      action: 'pause',
      parameters: { b: 2, a: 1 },
      issued_at: '2026-04-21T18:00:00.000Z',
    });
    const b = canonicalCommandString('k1', {
      command_id: 'cid',
      device_id: 'dev',
      action: 'pause',
      parameters: { a: 1, b: 2 },
      issued_at: '2026-04-21T18:00:00.000Z',
    });
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toContain('{"a":1,"b":2}');
  });

  it('emits empty string for null parameters', () => {
    const s = canonicalCommandString('k1', {
      command_id: 'cid',
      device_id: 'dev',
      action: 'pause',
      parameters: null,
      issued_at: '2026-04-21T18:00:00.000Z',
    }).toString();
    // line 5 (0-indexed 4) should be empty between two newlines.
    expect(s.split('\n')[4]).toBe('');
  });

  it('includes issued_at as unix seconds', () => {
    const s = canonicalCommandString('k1', {
      command_id: 'cid',
      device_id: 'dev',
      action: 'pause',
      parameters: null,
      issued_at: '2026-04-21T18:00:00.000Z',
    }).toString();
    const lastLine = s.split('\n').slice(-1)[0];
    expect(Number(lastLine)).toBe(Math.floor(Date.parse('2026-04-21T18:00:00.000Z') / 1000));
  });
});

describe('loadCommandSigner', () => {
  let origKeyId: string | undefined;
  let origKeyB64: string | undefined;

  beforeEach(() => {
    origKeyId = process.env.COMMAND_SIGNING_KEY_ID;
    origKeyB64 = process.env.COMMAND_SIGNING_PRIVATE_KEY_B64;
    _resetForTests();
  });
  afterEach(() => {
    if (origKeyId !== undefined) process.env.COMMAND_SIGNING_KEY_ID = origKeyId;
    else delete process.env.COMMAND_SIGNING_KEY_ID;
    if (origKeyB64 !== undefined) process.env.COMMAND_SIGNING_PRIVATE_KEY_B64 = origKeyB64;
    else delete process.env.COMMAND_SIGNING_PRIVATE_KEY_B64;
    _resetForTests();
  });

  it('throws when env is unset', () => {
    delete process.env.COMMAND_SIGNING_KEY_ID;
    delete process.env.COMMAND_SIGNING_PRIVATE_KEY_B64;
    expect(() => loadCommandSigner()).toThrow(/command signing unavailable/);
  });

  it('signs a command and produces a signature that verifies with the paired public key', () => {
    const { keyIdEnv, privateKeyB64 } = generateKeyMaterial();
    process.env.COMMAND_SIGNING_KEY_ID = keyIdEnv;
    process.env.COMMAND_SIGNING_PRIVATE_KEY_B64 = privateKeyB64;

    const signer = loadCommandSigner();
    const cmd = {
      command_id: 'cid',
      device_id: 'dev',
      action: 'pause',
      parameters: { reason: 'test' },
      issued_at: '2026-04-21T18:00:00.000Z',
    };
    const sigB64 = signer.sign(cmd);
    const spkiB64 = signer.publicKeySpkiB64();

    const canonical = canonicalCommandString(signer.keyId, cmd);
    const pub = crypto.createPublicKey({
      key: Buffer.from(spkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = crypto.verify(
      'sha256',
      canonical,
      { key: pub, dsaEncoding: 'der' },
      Buffer.from(sigB64, 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('rejects tampered payloads at verify time', () => {
    const { keyIdEnv, privateKeyB64 } = generateKeyMaterial();
    process.env.COMMAND_SIGNING_KEY_ID = keyIdEnv;
    process.env.COMMAND_SIGNING_PRIVATE_KEY_B64 = privateKeyB64;

    const signer = loadCommandSigner();
    const cmd = {
      command_id: 'cid',
      device_id: 'dev',
      action: 'pause',
      parameters: null,
      issued_at: '2026-04-21T18:00:00.000Z',
    };
    const sigB64 = signer.sign(cmd);
    const spkiB64 = signer.publicKeySpkiB64();

    // Attacker promotes 'pause' -> 'revoke' in the payload while
    // keeping the signature from the 'pause' canonical string.
    const canonicalTampered = canonicalCommandString(signer.keyId, {
      ...cmd,
      action: 'revoke',
    });
    const pub = crypto.createPublicKey({
      key: Buffer.from(spkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = crypto.verify(
      'sha256',
      canonicalTampered,
      { key: pub, dsaEncoding: 'der' },
      Buffer.from(sigB64, 'base64'),
    );
    expect(ok).toBe(false);
  });
});
