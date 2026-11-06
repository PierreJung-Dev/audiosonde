import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { signPayload } from '../../src/hmac.js';
import type { Config } from '../../src/config.js';
import { fakeResolveBinaries, TEST_SECRET, testConfig } from '../helpers.js';
import { FIXTURES, fixturePath } from '../fixture-gen.js';
import { MockCaller, loopbackAllowedPolicy } from '../mock-caller.js';

/** M2 end-to-end: metadata analyzer through the real HTTP pipeline. */

const config: Config = {
  ...testConfig,
  maxConcurrentJobs: 2,
  maxSourceBytes: 10 * 1024 * 1024,
  jobTimeoutMs: 30_000,
  analyzerTimeoutMs: 30_000,
};

describe('metadata via full pipeline', () => {
  let caller: MockCaller;
  let app: FastifyInstance;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-test-'));
    caller = new MockCaller();
    await caller.start();
    caller.serve('/fixture.flac', { data: await readFile(fixturePath(FIXTURES.flac)) });

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

  it('fetch → ffprobe → signed callback carries result.metadata', async () => {
    const body = {
      jobId: 'meta-e2e',
      source: { url: caller.url('/fixture.flac') },
      analyses: ['metadata'],
      callback: { url: caller.url('/callback') },
    };
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
    expect(res.statusCode).toBe(202);

    await caller.waitForCallbacks(1, 15_000);
    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('done');

    const result = cb?.body['result'] as { metadata: Record<string, unknown> };
    expect(result.metadata).toMatchObject({
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      container: 'flac',
      codec: 'flac',
    });
    expect((result.metadata['tags'] as Record<string, string>)['title']).toBe('Fixture Sine');

    const engine = cb?.body['engine'] as { algoVersions: Record<string, number> };
    expect(engine.algoVersions['metadata']).toBe(1);

    const timings = cb?.body['timings'] as { perAnalyzerMs: Record<string, number> };
    expect(timings.perAnalyzerMs['metadata']).toBeGreaterThanOrEqual(0);
  });
});
