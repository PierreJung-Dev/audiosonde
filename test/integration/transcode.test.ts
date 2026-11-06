import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { signPayload } from '../../src/hmac.js';
import type { Config } from '../../src/config.js';
import { measureLoudness } from '../../src/media/loudness.js';
import { probeFile } from '../../src/media/probe.js';
import { fakeResolveBinaries, TEST_SECRET, testConfig } from '../helpers.js';
import { FIXTURES, fixturePath } from '../fixture-gen.js';
import { MockCaller, loopbackAllowedPolicy } from '../mock-caller.js';

/**
 * M3 acceptance: loudness + transcode through the full pipeline with artifact
 * upload to a mock signed-PUT server; normalization lands within ±0.5 LU of
 * target (re-measured); derivatives survive an ffprobe round-trip; an expired
 * PUT URL yields ARTIFACT_UPLOAD_FAILED and status "partial".
 */

const config: Config = {
  ...testConfig,
  maxConcurrentJobs: 2,
  maxSourceBytes: 10 * 1024 * 1024,
  maxDurationMs: 60_000, // the duration-cap test overrides this downward
  jobTimeoutMs: 60_000,
  analyzerTimeoutMs: 60_000,
};

const TOOL_OPTS = {
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  timeoutMs: 30_000,
  signal: new AbortController().signal,
};

describe('loudness + transcode via full pipeline', () => {
  let caller: MockCaller;
  let app: FastifyInstance;
  let tmpRoot: string;
  let scratch: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-test-'));
    scratch = await mkdtemp(join(tmpdir(), 'audiosonde-artifacts-'));
    caller = new MockCaller();
    await caller.start();
    caller.serve('/noise.wav', { data: await readFile(fixturePath(FIXTURES.noiseWav)) });

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
    await rm(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    caller.callbacks.length = 0;
    caller.puts.length = 0;
    caller.putStatus = 200;
  });

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

  it('mp3 + targetLufs: normalized within ±0.5 LU, decodes, uploaded', async () => {
    const target = -16;
    // 320 kbps: the ±0.5 LU acceptance criterion checks NORMALIZATION
    // accuracy, so the codec must be transparent. At 128 kbps, mp3 sheds
    // audible-band-edge energy of full-spectrum pink noise (≈ -0.6 LU under
    // K-weighting) — a codec property, not a normalization error.
    expect(
      await submit({
        jobId: 'tc-mp3',
        source: { url: caller.url('/noise.wav') },
        analyses: ['loudness', 'transcode'],
        outputs: {
          transcode: {
            putUrl: caller.url('/artifacts/derivative.mp3'),
            format: 'mp3',
            bitrateKbps: 320,
            targetLufs: target,
          },
        },
        callback: { url: caller.url('/callback') },
      }),
    ).toBe(202);
    await caller.waitForCallbacks(1, 30_000);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('done');

    const result = cb?.body['result'] as {
      loudness: { integratedLufs: number };
      transcode: Record<string, unknown>;
    };
    // Source measurement present and sane.
    expect(result.loudness.integratedLufs).toBeLessThan(-18);
    expect(result.transcode).toMatchObject({
      uploaded: true,
      format: 'mp3',
      bitrateKbps: 320,
      normalizedToLufs: target,
    });

    // The artifact arrived via signed PUT with the documented content type.
    const put = caller.puts[0];
    expect(put?.path).toBe('/artifacts/derivative.mp3');
    expect(put?.headers['content-type']).toBe('audio/mpeg');
    expect(put?.body.length).toBeGreaterThan(1000);
    expect(result.transcode['byteSize']).toBe(put?.body.length);

    // Round-trip: the uploaded derivative decodes and is normalized.
    const artifact = join(scratch, 'derivative.mp3');
    await writeFile(artifact, put?.body ?? Buffer.alloc(0));
    const probe = await probeFile(artifact, TOOL_OPTS);
    expect(probe.audioStream.codec_name).toBe('mp3');
    const remeasured = await measureLoudness(artifact, TOOL_OPTS);
    expect(remeasured.inputI).not.toBeNull();
    expect(Math.abs((remeasured.inputI ?? 0) - target)).toBeLessThanOrEqual(0.5);
  });

  it('opus without normalization: decodes, normalizedToLufs null', async () => {
    expect(
      await submit({
        jobId: 'tc-opus',
        source: { url: caller.url('/noise.wav') },
        analyses: ['transcode'],
        outputs: {
          transcode: {
            putUrl: caller.url('/artifacts/derivative.opus'),
            format: 'opus',
            bitrateKbps: 96,
          },
        },
        callback: { url: caller.url('/callback') },
      }),
    ).toBe(202);
    await caller.waitForCallbacks(1, 30_000);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('done');
    const result = cb?.body['result'] as { transcode: Record<string, unknown> };
    expect(result.transcode).toMatchObject({
      uploaded: true,
      format: 'opus',
      bitrateKbps: 96,
      normalizedToLufs: null,
    });

    const put = caller.puts[0];
    expect(put?.headers['content-type']).toBe('audio/ogg');
    const artifact = join(scratch, 'derivative.opus');
    await writeFile(artifact, put?.body ?? Buffer.alloc(0));
    const probe = await probeFile(artifact, TOOL_OPTS);
    expect(probe.audioStream.codec_name).toBe('opus');
    expect(probe.audioStream.sample_rate).toBe('48000');
  });

  it('expired PUT URL → ARTIFACT_UPLOAD_FAILED, status partial', async () => {
    caller.putStatus = 403;
    expect(
      await submit({
        jobId: 'tc-expired',
        source: { url: caller.url('/noise.wav') },
        analyses: ['loudness', 'transcode'],
        outputs: {
          transcode: {
            putUrl: caller.url('/artifacts/never.mp3'),
            format: 'mp3',
            bitrateKbps: 128,
          },
        },
        callback: { url: caller.url('/callback') },
      }),
    ).toBe(202);
    await caller.waitForCallbacks(1, 30_000);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('partial'); // loudness succeeded
    const result = cb?.body['result'] as Record<string, unknown>;
    expect(result['loudness']).toBeDefined();
    expect(result['transcode']).toBeUndefined();
    const errors = cb?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'ARTIFACT_UPLOAD_FAILED',
      analyzer: 'transcode',
      retryable: false,
    });
    expect(String(errors[0]?.['message'])).toContain('403');
  });

  it('source over the duration limit → UNSUPPORTED_FORMAT, failed', async () => {
    const capped = buildServer({
      config: { ...config, maxDurationMs: 2000 }, // noise fixture is 3 s
      loggerEnabled: false,
      resolveBinaries: fakeResolveBinaries,
      addressPolicy: loopbackAllowedPolicy,
      tmpRoot,
      callbackBaseDelayMs: 1,
    });
    await capped.ready();
    const payload = JSON.stringify({
      jobId: 'tc-too-long',
      source: { url: caller.url('/noise.wav') },
      analyses: ['loudness'],
      callback: { url: caller.url('/callback') },
    });
    const res = await capped.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        'content-type': 'application/json',
        'x-audiosonde-signature': signPayload(TEST_SECRET, payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(202);
    await caller.waitForCallbacks(1, 30_000);
    await capped.close();

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('failed');
    const errors = cb?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors[0]?.['code']).toBe('UNSUPPORTED_FORMAT');
    expect(String(errors[0]?.['message'])).toContain('duration');
  });
});
