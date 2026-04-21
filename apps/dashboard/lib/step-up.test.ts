import { describe, expect, it } from 'vitest';
import { STEPUP_TTL_SECONDS, issueStepUp, verifyStepUp } from './step-up';

const SECRET = 'x'.repeat(32);

describe('step-up tokens', () => {
  it('round-trips for the same email', () => {
    const t = issueStepUp('alice@firm.test', SECRET);
    expect(verifyStepUp(t, 'alice@firm.test', SECRET)).not.toBeNull();
  });

  it('is case-insensitive on the email', () => {
    const t = issueStepUp('alice@firm.test', SECRET);
    expect(verifyStepUp(t, 'ALICE@FIRM.TEST', SECRET)).not.toBeNull();
  });

  it('rejects a token issued for a different email', () => {
    const t = issueStepUp('alice@firm.test', SECRET);
    expect(verifyStepUp(t, 'bob@firm.test', SECRET)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const t = issueStepUp('alice@firm.test', SECRET);
    const tampered = `${t.slice(0, -2)}ZZ`;
    expect(verifyStepUp(tampered, 'alice@firm.test', SECRET)).toBeNull();
  });

  it('rejects a token past its TTL', () => {
    const past = new Date(Date.now() - (STEPUP_TTL_SECONDS + 60) * 1000);
    const t = issueStepUp('alice@firm.test', SECRET, past);
    expect(verifyStepUp(t, 'alice@firm.test', SECRET)).toBeNull();
  });

  it('rejects an empty/undefined cookie', () => {
    expect(verifyStepUp(undefined, 'alice@firm.test', SECRET)).toBeNull();
    expect(verifyStepUp('', 'alice@firm.test', SECRET)).toBeNull();
  });

  it('rejects when issued under a different secret (HMAC context domain-separation)', () => {
    const t = issueStepUp('alice@firm.test', SECRET);
    expect(verifyStepUp(t, 'alice@firm.test', `${SECRET}x`)).toBeNull();
  });
});
