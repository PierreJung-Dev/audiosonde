import { describe, expect, it } from 'vitest';
import { computeSignature, signPayload, verifySignature } from '../src/hmac.js';

const secret = 'top-secret';
const body = JSON.stringify({ jobId: 'abc', hello: 'world' });

describe('signPayload / computeSignature', () => {
  it('produces a header parseable back to a valid signature', () => {
    const t = 1_700_000_000;
    const header = signPayload(secret, body, t);
    expect(header).toBe(`t=${t},v1=${computeSignature(secret, t, body)}`);
  });
});

describe('verifySignature', () => {
  const now = 1_700_000_000;

  it('accepts a valid signature within the window', () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature(secret, body, header, { now })).toEqual({ ok: true });
  });

  it('rejects a missing header', () => {
    expect(verifySignature(secret, body, undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(verifySignature(secret, body, '')).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a malformed header', () => {
    expect(verifySignature(secret, body, 'garbage')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySignature(secret, body, 't=123')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySignature(secret, body, 't=notnum,v1=aa')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a tampered body or wrong secret', () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature(secret, body + 'x', header, { now })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifySignature('other', body, header, { now })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a replayed/expired signature', () => {
    const header = signPayload(secret, body, now);
    expect(verifySignature(secret, body, header, { now: now + 301 })).toEqual({ ok: false, reason: 'expired' });
    expect(verifySignature(secret, body, header, { now: now - 301 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts either secret during rotation (primary or previous)', () => {
    const primary = 'new-secret';
    const previous = 'old-secret';
    const accepted = [primary, previous];
    const signedWithPrevious = signPayload(previous, body, now);
    const signedWithPrimary = signPayload(primary, body, now);
    expect(verifySignature(accepted, body, signedWithPrevious, { now })).toEqual({ ok: true });
    expect(verifySignature(accepted, body, signedWithPrimary, { now })).toEqual({ ok: true });
    expect(verifySignature(accepted, body, signPayload('unknown', body, now), { now })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
