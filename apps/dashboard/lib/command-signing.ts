import crypto, { type KeyObject } from 'node:crypto';

/**
 * Signs `pending_command` rows before they are handed to the agent.
 *
 * The agent verifies this signature before executing. Prevents a MITM
 * (corporate TLS proxy, hostile Wi-Fi, compromised CA) from injecting
 * `revoke` / `restart_machine` into a poll response: the TLS channel
 * authenticates the host, but the command content is only trusted if
 * it carries our backend's ECDSA signature.
 *
 * Key distribution: the backend public key is returned to the agent
 * in the `/v1/enroll` response (authenticated by pairing-code
 * possession). Rotation is indicated by `key_id`; the agent refuses
 * commands whose `key_id` does not match the key it has on file.
 *
 * Canonical string format (ordered, newline-delimited — must stay in
 * lockstep with `verify_command_signature()` in the Python agent):
 *
 *     {key_id}\n
 *     {command_id}\n
 *     {device_id}\n
 *     {action}\n
 *     {parameters_canonical}\n
 *     {issued_at_epoch_seconds}
 *
 * `parameters_canonical` is either the empty string (when parameters
 * is null / undefined) or the JSON encoding with keys sorted at every
 * nesting level.
 */

export interface CommandToSign {
  command_id: string;
  device_id: string;
  action: string;
  parameters: unknown;
  issued_at: string;
}

export interface CommandSigner {
  keyId: string;
  sign(cmd: CommandToSign): string;
  publicKeySpkiB64(): string;
}

function sortedJson(v: unknown): string {
  if (v === null || v === undefined) return '';
  const seen = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x as object)) throw new Error('cycle in parameters');
    seen.add(x as object);
    if (Array.isArray(x)) return x.map(walk);
    const keys = Object.keys(x as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = walk((x as Record<string, unknown>)[k]);
    return out;
  };
  return JSON.stringify(walk(v));
}

export function canonicalCommandString(keyId: string, cmd: CommandToSign): Buffer {
  const ts = Math.floor(Date.parse(cmd.issued_at) / 1000);
  if (!Number.isFinite(ts)) throw new Error('invalid issued_at');
  const params = sortedJson(cmd.parameters);
  return Buffer.from(
    `${keyId}\n${cmd.command_id}\n${cmd.device_id}\n${cmd.action}\n${params}\n${ts}`,
  );
}

let cached: { signer: CommandSigner; privateKey: KeyObject } | null = null;

/**
 * Construct (and memoize) the command signer from env. Throws at call
 * time if the key material is missing — which is intentional: we want
 * the admin endpoint to fail loudly rather than hand the agent
 * unsigned commands. Test suites should pass an explicit signer via
 * `CommandSigner` constructor fixture rather than touching env.
 */
export function loadCommandSigner(): CommandSigner {
  if (cached) return cached.signer;
  const keyId = process.env.COMMAND_SIGNING_KEY_ID;
  const b64 = process.env.COMMAND_SIGNING_PRIVATE_KEY_B64;
  if (!keyId || !b64) {
    throw new Error(
      'command signing unavailable: COMMAND_SIGNING_KEY_ID and ' +
        'COMMAND_SIGNING_PRIVATE_KEY_B64 must be set',
    );
  }
  const der = Buffer.from(b64, 'base64');
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  cached = {
    privateKey,
    signer: {
      keyId,
      sign(cmd) {
        const canonical = canonicalCommandString(keyId, cmd);
        const sig = crypto.sign('sha256', canonical, { key: privateKey, dsaEncoding: 'der' });
        return sig.toString('base64');
      },
      publicKeySpkiB64() {
        const pub = crypto.createPublicKey(privateKey);
        return pub.export({ format: 'der', type: 'spki' }).toString('base64');
      },
    },
  };
  return cached.signer;
}

/** Test hook: inject a signer built from a provided PKCS8 DER. */
export function _resetForTests(): void {
  cached = null;
}
