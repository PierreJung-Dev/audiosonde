import { execa } from 'execa';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { signPayload } from '../../src/hmac.js';
import type { Config } from '../../src/config.js';
import { fakeResolveBinaries, TEST_SECRET, testConfig } from '../helpers.js';
import { FIXTURES, fixturePath } from '../fixture-gen.js';
import { MockCaller, loopbackAllowedPolicy } from '../mock-caller.js';

/**
 * M4 acceptance: multi-zoom peaks via the full pipeline, golden byte-compare
 * against a direct audiowaveform invocation of the SAME binary (so brew's and
 * the Docker image's versions each stay self-consistent), plus the documented
 * .dat decode (docs/peaks-format.md) applied to real engine output.
 */

const config: Config = {
  ...testConfig,
  maxConcurrentJobs: 2,
  maxSourceBytes: 10 * 1024 * 1024,
  maxDurationMs: 60_000,
  jobTimeoutMs: 60_000,
  analyzerTimeoutMs: 60_000,
};

/** Decoder mirroring docs/peaks-format.md — keep the two in sync. */
function decodeDat(buf: Buffer): {
  version: number;
  bits: 8 | 16;
  sampleRate: number;
  samplesPerPixel: number;
  length: number;
  channels: number;
  pairs: Array<[number, number]>;
} {
  const version = buf.readInt32LE(0);
  const flags = buf.readUInt32LE(4);
  const bits = (flags & 1) === 1 ? 8 : 16;
  const sampleRate = buf.readInt32LE(8);
  const samplesPerPixel = buf.readInt32LE(12);
  const length = buf.readUInt32LE(16);
  const channels = version === 2 ? buf.readInt32LE(20) : 1;
  const dataStart = version === 2 ? 24 : 20;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < length * channels; i += 1) {
    if (bits === 8) {
      pairs.push([buf.readInt8(dataStart + i * 2), buf.readInt8(dataStart + i * 2 + 1)]);
    } else {
      pairs.push([buf.readInt16LE(dataStart + i * 4), buf.readInt16LE(dataStart + i * 4 + 2)]);
    }
  }
  return { version, bits, sampleRate, samplesPerPixel, length, channels, pairs };
}

describe('peaks via full pipeline', () => {
  let caller: MockCaller;
  let app: FastifyInstance;
  let tmpRoot: string;
  let scratch: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-test-'));
    scratch = await mkdtemp(join(tmpdir(), 'audiosonde-golden-'));
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

  /** The engine's intermediate decode + audiowaveform, run independently. */
  async function golden(zoom: number, format: 'dat' | 'json', bits: number): Promise<Buffer> {
    const wav = join(scratch, 'golden-input.wav');
    await execa('ffmpeg', ['-y', '-v', 'error', '-i', fixturePath(FIXTURES.noiseWav), '-vn', '-c:a', 'pcm_s16le', '-f', 'wav', wav]);
    const out = join(scratch, `golden-${zoom}.${format}`);
    await execa('audiowaveform', ['--input-format', 'wav', '-i', wav, '--output-format', format, '-o', out, '-z', String(zoom), '-b', String(bits), '-q']);
    return readFile(out);
  }

  it('multi-zoom dat: golden byte-compare, decodable header, uploaded', async () => {
    expect(
      await submit({
        jobId: 'peaks-dat',
        source: { url: caller.url('/noise.wav') },
        analyses: ['peaks'],
        outputs: {
          peaks: {
            format: 'audiowaveform-dat',
            levels: [
              { zoom: 256, putUrl: caller.url('/artifacts/peaks-256.dat') },
              { zoom: 1024, putUrl: caller.url('/artifacts/peaks-1024.dat') },
            ],
          },
        },
        callback: { url: caller.url('/callback') },
      }),
    ).toBe(202);
    await caller.waitForCallbacks(1, 30_000);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('done');
    const result = cb?.body['result'] as { peaks: Record<string, unknown> };
    expect(result.peaks).toMatchObject({
      uploaded: true,
      format: 'audiowaveform-dat',
      zoomLevels: [256, 1024],
      bits: 8,
    });

    expect(caller.puts).toHaveLength(2);
    const put256 = caller.puts.find((p) => p.path === '/artifacts/peaks-256.dat');
    const put1024 = caller.puts.find((p) => p.path === '/artifacts/peaks-1024.dat');
    expect(put256?.headers['content-type']).toBe('application/octet-stream');

    // Golden byte-compare against a direct invocation of the same binary.
    expect(put256?.body.equals(await golden(256, 'dat', 8))).toBe(true);
    expect(put1024?.body.equals(await golden(1024, 'dat', 8))).toBe(true);

    // The documented decode example works on real engine output.
    const decoded = decodeDat(put256?.body ?? Buffer.alloc(0));
    expect(decoded.bits).toBe(8);
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.samplesPerPixel).toBe(256);
    // 3 s at 44.1 kHz / 256 spp ≈ 517 pixels
    expect(decoded.length).toBeGreaterThan(500);
    expect(decoded.length).toBeLessThan(530);
    expect(decoded.pairs.length).toBe(decoded.length * decoded.channels);
    // Pink noise: min < 0 < max for essentially every pixel.
    const [min0, max0] = decoded.pairs[0] ?? [0, 0];
    expect(min0).toBeLessThan(0);
    expect(max0).toBeGreaterThan(0);

    const byteSize = result.peaks['byteSize'] as number;
    expect(byteSize).toBe((put256?.body.length ?? 0) + (put1024?.body.length ?? 0));
  });

  it('json format: valid, sane fields, golden byte-compare', async () => {
    expect(
      await submit({
        jobId: 'peaks-json',
        source: { url: caller.url('/noise.wav') },
        analyses: ['peaks'],
        outputs: {
          peaks: {
            format: 'json',
            levels: [{ zoom: 512, putUrl: caller.url('/artifacts/peaks-512.json') }],
            bits: 16,
          },
        },
        callback: { url: caller.url('/callback') },
      }),
    ).toBe(202);
    await caller.waitForCallbacks(1, 30_000);

    expect(caller.callbacks[0]?.body['status']).toBe('done');
    const put = caller.puts[0];
    expect(put?.headers['content-type']).toBe('application/json');
    expect(put?.body.equals(await golden(512, 'json', 16))).toBe(true);

    const parsed = JSON.parse((put?.body ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>;
    expect(parsed['sample_rate']).toBe(44100);
    expect(parsed['samples_per_pixel']).toBe(512);
    expect(parsed['bits']).toBe(16);
    expect(Array.isArray(parsed['data'])).toBe(true);
  });

  it('rejected PUT on one level → ARTIFACT_UPLOAD_FAILED, status failed for peaks-only job', async () => {
    caller.putStatus = 403;
    expect(
      await submit({
        jobId: 'peaks-expired',
        source: { url: caller.url('/noise.wav') },
        analyses: ['peaks'],
        outputs: {
          peaks: {
            format: 'audiowaveform-dat',
            levels: [{ zoom: 256, putUrl: caller.url('/artifacts/never.dat') }],
          },
        },
        callback: { url: caller.url('/callback') },
      }),
    ).toBe(202);
    await caller.waitForCallbacks(1, 30_000);

    const cb = caller.callbacks[0];
    expect(cb?.body['status']).toBe('failed');
    const errors = cb?.body['errors'] as Array<Record<string, unknown>>;
    expect(errors[0]).toMatchObject({
      code: 'ARTIFACT_UPLOAD_FAILED',
      analyzer: 'peaks',
      retryable: false,
    });
  });
});
