import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchCallback } from '../src/pipeline/callback.js';
import { verifySignature } from '../src/hmac.js';
import { MockCaller, loopbackAllowedPolicy } from './mock-caller.js';
import { TEST_SECRET } from './helpers.js';

describe('dispatchCallback', () => {
  let caller: MockCaller;

  beforeEach(async () => {
    caller = new MockCaller();
    await caller.start();
  });

  afterEach(async () => {
    await caller.stop();
  });

  const opts = { secret: TEST_SECRET, policy: loopbackAllowedPolicy, baseDelayMs: 1 };

  it('delivers a signed payload on the first attempt', async () => {
    const outcome = await dispatchCallback(caller.url('/callback'), { jobId: 'j1' }, opts);
    expect(outcome).toMatchObject({ delivered: true, attempts: 1 });

    const received = caller.callbacks[0];
    expect(received).toBeDefined();
    expect(received?.body).toEqual({ jobId: 'j1' });
    // The signature must verify against the raw body with the shared secret.
    const header = received?.headers['x-audiosonde-signature'];
    const verdict = verifySignature([TEST_SECRET], received?.rawBody ?? '', header as string);
    expect(verdict).toEqual({ ok: true });
  });

  it('retries on non-2xx and succeeds when the caller recovers', async () => {
    caller.callbackStatuses = [500, 503, 200];
    const outcome = await dispatchCallback(caller.url('/callback'), { jobId: 'j2' }, opts);
    expect(outcome).toMatchObject({ delivered: true, attempts: 3 });
    expect(caller.callbacks).toHaveLength(3);
  });

  it('gives up after 5 attempts of non-2xx', async () => {
    caller.callbackStatuses = [500];
    const outcome = await dispatchCallback(caller.url('/callback'), { jobId: 'j3' }, opts);
    expect(outcome).toMatchObject({ delivered: false, attempts: 5, lastStatus: 500 });
    expect(caller.callbacks).toHaveLength(5);
  });

  it('does not retry an SSRF-blocked callback URL', async () => {
    const outcome = await dispatchCallback('http://169.254.169.254/callback', { jobId: 'j4' }, opts);
    expect(outcome.delivered).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastError).toContain('refusing to connect');
  });

  it('refuses to follow a method-changing redirect on POST', async () => {
    caller.redirect('/callback-elsewhere', caller.url('/callback'), 302);
    const outcome = await dispatchCallback(
      caller.url('/callback-elsewhere'),
      { jobId: 'j5' },
      { ...opts, attempts: 2 },
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.lastError).toContain('refusing to change method');
    expect(caller.callbacks).toHaveLength(0);
  });

  it('follows a 307 redirect, preserving method and body', async () => {
    caller.redirect('/callback-moved', caller.url('/callback'), 307);
    const outcome = await dispatchCallback(caller.url('/callback-moved'), { jobId: 'j6' }, opts);
    expect(outcome).toMatchObject({ delivered: true, attempts: 1 });
    expect(caller.callbacks[0]?.body).toEqual({ jobId: 'j6' });
  });
});
