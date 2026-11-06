import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { signPayload } from '../../src/hmac.js';
import type { Config } from '../../src/config.js';
import { fakeResolveBinaries, TEST_SECRET, testConfig } from '../helpers.js';
import { FIXTURE_DIR } from '../fixture-gen.js';
import { MockCaller, loopbackAllowedPolicy } from '../mock-caller.js';

/** M5 end-to-end: bpm + key analyzers through the real HTTP pipeline. */

const config: Config = {
  ...testConfig,
  maxConcurrentJobs: 2,
  maxSourceBytes: 20 * 1024 * 1024,
  maxDurationMs: 60_000,
  jobTimeoutMs: 60_000,
  analyzerTimeoutMs: 60_000,
};

describe('bpm + key via full pipeline', () => {
  let caller: MockCaller;
  let app: FastifyInstance;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-test-'));
    caller = new MockCaller();
    await caller.start();
    caller.serve('/click.wav', { data: await readFile(join(FIXTURE_DIR, 'click-120.wav')) });
    caller.serve('/cadence.wav', { data: await readFile(join(FIXTURE_DIR, 'cadence-A-minor.wav')) });

    app = buildServer({
      config,
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

  async function submit(jobId: string, sourcePath: string, analyses: string[]): Promise<void> {
    const body = {
      jobId,
      source: { url: caller.url(sourcePath) },
      analyses,
      callback: { url: caller.url('/callback') },
    };
    const payload = JSON.stringify(body);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json', 'x-audiosonde-signature': signPayload(TEST_SECRET, payload) },
      payload,
    });
    expect(res.statusCode).toBe(202);
  }

  it('bpm: click track → value ~120, calibrated confidence, algoVersion in callback', async () => {
    await submit('bpm-e2e', '/click.wav', ['bpm']);
    await caller.waitForCallbacks(1, 30_000);
    const cb = caller.callbacks.find((c) => c.body['jobId'] === 'bpm-e2e');
    expect(cb?.body['status']).toBe('done');
    const bpm = (cb?.body['result'] as { bpm: { value: number; confidence: number } }).bpm;
    expect([1, 2, 0.5].some((m) => Math.abs(bpm.value - 120 * m) <= 0.02 * 120 * m)).toBe(true);
    expect(bpm.confidence).toBe(0.9);
    const engine = cb?.body['engine'] as { algoVersions: Record<string, number> };
    expect(engine.algoVersions['bpm']).toBe(1);
  });

  it('key: A-minor cadence → {key: "A", scale: "minor"} with confidence', async () => {
    await submit('key-e2e', '/cadence.wav', ['key']);
    await caller.waitForCallbacks(2, 30_000);
    const cb = caller.callbacks.find((c) => c.body['jobId'] === 'key-e2e');
    expect(cb?.body['status']).toBe('done');
    const key = (cb?.body['result'] as { key: { key: string; scale: string; confidence: number } }).key;
    expect(key).toMatchObject({ key: 'A', scale: 'minor' });
    expect(key.confidence).toBeGreaterThan(0.5);
    const engine = cb?.body['engine'] as { algoVersions: Record<string, number> };
    expect(engine.algoVersions['key']).toBe(1);
  });
});
