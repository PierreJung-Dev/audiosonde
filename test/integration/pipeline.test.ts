import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { signPayload, verifySignature } from '../../src/hmac.js';
import { JobRunner, type RunnerLogger } from '../../src/pipeline/runner.js';
import type { Config } from '../../src/config.js';
import { fakeResolveBinaries, TEST_SECRET, testConfig } from '../helpers.js';
import { makeTestWav } from '../fixtures.js';
import { MockCaller, loopbackAllowedPolicy } from '../mock-caller.js';

/**
 * M1 acceptance: a local mock caller serves the source fixture and receives
 * the signed callback — happy path, SSRF-blocked URL, hash mismatch,
 * oversized source — plus 429 backpressure and tmp-dir cleanup.
 */

const integrationConfig: Config = {
  ...testConfig,
  maxConcurrentJobs: 1,
  maxSourceBytes: 1024 * 1024,
  jobTimeoutMs: 5000,
  analyzerTimeoutMs: 5000,
};

describe('pipeline integration (mock caller)', () => {
  let caller: MockCaller;
  let app: FastifyInstance;
  let tmpRoot: string;
  const wav = makeTestWav();

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-test-'));
    caller = new MockCaller();
    await caller.start();
    caller.serve('/good.wav', { data: wav });
    caller.serve('/slow.wav', { data: wav, delayMs: 300 });
    caller.serve('/not-audio.bin', { data: Buffer.from('definitely not audio content here') });

    app = buildServer({
      config: integrationConfig,
      loggerEnabled: false,
      resolveBinaries: fakeResolveBinaries,
      addressPolicy: loopbackAllowedPolicy,
      tmpRoot,
      callbackBaseDelayMs: 1,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await caller.stop();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    caller.callbacks.length = 0;
    caller.callbackStatuses = [200];
  });

  function jobBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      jobId: `job-${Math.random().toString(36).slice(2)}`,
      source: { url: caller.url('/good.wav') },
      analyses: ['noop'],
      callback: { url: caller.url('/callback') },
      ...overrides,
    };
  }

  async function submit(body: Record<string, unknown>): Promise<number> {
    const payload = JSON.stringify(body);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        'content-type': 'application/json',
        'x-audiosonde-signature': signPayload(TEST_SECRET, payload),
      },
      payload,
    });
    return res.statusCode;
  }

  it('happy path: fetch → noop → signed callback with status done', async () => {
    const body = jobBody();
    expect(await submit(body)).toBe(202);
    await caller.waitForCallbacks(1);

    const cb = caller.callbacks[0];
    expect(cb).toBeDefined();

    // Callback is signed with the shared secret over the raw body.
    const verdict = verifySignature(
      [TEST_SECRET],
      cb?.rawBody ?? '',
      cb?.headers['x-audiosonde-signature'] as string,
    );
    expect(verdict).toEqual({ ok: true });

    expect(cb?.body).toMatchObject({
      jobId: body['jobId'],
      status: 'done',
      result: { noop: { ok: true } },
      errors: [],
    });
    const engine = cb?.body['engine'] as { version: string; algoVersions: Record<string, number> };
    expect(engine.algoVersions).toMatchObject({ noop: 1 });
    const timings = cb?.body['timings'] as { totalMs: number; downloadMs: number };
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(timings.downloadMs).toBeGreaterThanOrEqual(0);

    // Per-job tmp dir is removed after the job.
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('SSRF-blocked source URL → failed, SOURCE_FETCH_FAILED, not retryable', async () => {
    expect(
      await submit(jobBody({ source: { url: 'http://169.254.169.254/latest/meta-data' } })),
    ).toBe(202);
    await caller.waitForCallbacks(1);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('failed');
    const errors = cb?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'SOURCE_FETCH_FAILED',
      analyzer: null,
      retryable: false,
    });
    expect(String(errors[0]?.['message'])).toContain('refusing to connect');
  });

  it('redirect to a private address is blocked mid-chain', async () => {
    caller.redirect('/sneaky.wav', 'http://169.254.169.254/latest/meta-data');
    expect(await submit(jobBody({ source: { url: caller.url('/sneaky.wav') } }))).toBe(202);
    await caller.waitForCallbacks(1);

    const errors = caller.callbacks[0]?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors[0]).toMatchObject({ code: 'SOURCE_FETCH_FAILED', retryable: false });
    expect(String(errors[0]?.['message'])).toContain('refusing to connect');
  });

  it('hash mismatch → HASH_MISMATCH', async () => {
    expect(
      await submit(
        jobBody({
          source: { url: caller.url('/good.wav'), contentHash: `sha256:${'0'.repeat(64)}` },
        }),
      ),
    ).toBe(202);
    await caller.waitForCallbacks(1);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('failed');
    const errors = cb?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors[0]).toMatchObject({ code: 'HASH_MISMATCH', retryable: false });
  });

  it('correct contentHash passes', async () => {
    const digest = createHash('sha256').update(wav).digest('hex');
    expect(
      await submit(
        jobBody({ source: { url: caller.url('/good.wav'), contentHash: `sha256:${digest}` } }),
      ),
    ).toBe(202);
    await caller.waitForCallbacks(1);
    expect(caller.callbacks[0]?.body['status']).toBe('done');
  });

  it('oversized source → SOURCE_FETCH_FAILED mentioning the limit', async () => {
    expect(
      await submit(jobBody({ source: { url: caller.url('/good.wav'), maxBytes: 64 } })),
    ).toBe(202);
    await caller.waitForCallbacks(1);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('failed');
    const errors = cb?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors[0]?.['code']).toBe('SOURCE_FETCH_FAILED');
    expect(String(errors[0]?.['message'])).toContain('64');
    // tmp cleaned up on the failure path too
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('non-audio bytes → UNSUPPORTED_FORMAT', async () => {
    expect(await submit(jobBody({ source: { url: caller.url('/not-audio.bin') } }))).toBe(202);
    await caller.waitForCallbacks(1);

    const errors = caller.callbacks[0]?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors[0]).toMatchObject({ code: 'UNSUPPORTED_FORMAT', retryable: false });
  });

  it('429 backpressure when all slots are busy, slot released after completion', async () => {
    expect(await submit(jobBody({ source: { url: caller.url('/slow.wav') } }))).toBe(202);
    // maxConcurrentJobs = 1 and the first job is still downloading:
    expect(await submit(jobBody())).toBe(429);
    await caller.waitForCallbacks(1);
    // Slot freed → accepted again.
    expect(await submit(jobBody())).toBe(202);
    await caller.waitForCallbacks(2);
  });
});

describe('callback failure logging (runner unit)', () => {
  let caller: MockCaller;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-test-'));
    caller = new MockCaller();
    await caller.start();
    caller.serve('/good.wav', { data: makeTestWav() });
  });

  afterAll(async () => {
    await caller.stop();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('logs CALLBACK_FAILED after exhausting the 5 attempts', async () => {
    caller.callbackStatuses = [500];
    const errorLogs: Array<Record<string, unknown>> = [];
    const makeLog = (bindings: Record<string, unknown>): RunnerLogger => ({
      info: () => undefined,
      warn: () => undefined,
      error: (obj) => errorLogs.push({ ...bindings, ...(obj as Record<string, unknown>) }),
      child: (more) => makeLog({ ...bindings, ...more }),
    });
    const runner = new JobRunner({
      config: integrationConfig,
      log: makeLog({}),
      policy: loopbackAllowedPolicy,
      tmpRoot,
      callbackBaseDelayMs: 1,
    });

    expect(
      runner.tryStart({
        jobId: 'cb-fail',
        source: { url: caller.url('/good.wav') },
        analyses: ['noop'],
        callback: { url: caller.url('/callback') },
      }),
    ).toBe(true);
    await runner.drain();

    expect(caller.callbacks).toHaveLength(5);
    const failureLog = errorLogs.find((l) => l['code'] === 'CALLBACK_FAILED');
    expect(failureLog).toBeDefined();
    expect(failureLog).toMatchObject({ jobId: 'cb-fail', attempts: 5, lastStatus: 500 });
  });
});
