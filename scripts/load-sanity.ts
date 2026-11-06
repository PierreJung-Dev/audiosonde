import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildServer } from '../src/server.js';
import { signPayload } from '../src/hmac.js';
import type { Config } from '../src/config.js';
import { MockCaller, loopbackAllowedPolicy } from '../test/mock-caller.js';

/**
 * M6 load sanity: N concurrent FULL jobs (metadata + loudness + transcode +
 * peaks + bpm + key) against a realistic source, watching the engine
 * process's peak RSS. Run locally (`pnpm load:sanity`), with the real
 * binaries on PATH:
 *
 *   MAX_CONCURRENT_JOBS=4 WAVES=3 pnpm load:sanity
 *
 * Measures the Node process only — each job additionally runs ONE
 * ffmpeg/ffprobe/audiowaveform subprocess at a time (they count against a
 * container's cgroup limit; see docs/architecture.md "Sizing" for numbers).
 */

const SECRET = 'load-sanity-secret';
const CONCURRENCY = Number(process.env['MAX_CONCURRENT_JOBS'] ?? 4);
const WAVES = Number(process.env['WAVES'] ?? 3);
const SOURCE_MINUTES = Number(process.env['SOURCE_MINUTES'] ?? 3);

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-load-'));

  // Realistic source: stereo noise, 44.1 kHz, 16-bit wav (~31 MB/3 min).
  const sourcePath = join(tmpRoot, 'source.wav');
  await execa('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', `anoisesrc=color=pink:duration=${SOURCE_MINUTES * 60}:sample_rate=44100:amplitude=0.5`,
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    sourcePath,
  ]);
  const source = await readFile(sourcePath);
  console.log(`source: ${(source.length / 1e6).toFixed(1)} MB wav (${SOURCE_MINUTES} min pink noise)`);

  const caller = new MockCaller();
  await caller.start();
  caller.serve('/source.wav', { data: source });

  const config: Config = {
    signingSecret: SECRET,
    acceptedSecrets: [SECRET],
    host: '127.0.0.1',
    port: 0,
    maxConcurrentJobs: CONCURRENCY,
    maxSourceBytes: 500 * 1024 * 1024,
    maxDurationMs: 4 * 60 * 60 * 1000,
    jobTimeoutMs: 10 * 60 * 1000,
    analyzerTimeoutMs: 5 * 60 * 1000,
    signatureToleranceSeconds: 300,
    metricsEnabled: true,
    binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', audiowaveform: 'audiowaveform' },
  };

  const app = buildServer({
    config,
    loggerEnabled: false,
    addressPolicy: loopbackAllowedPolicy,
    tmpRoot,
  });
  await app.ready();

  let peakRss = 0;
  const baseline = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);

  const submit = async (jobId: string): Promise<number> => {
    const payload = JSON.stringify({
      jobId,
      source: { url: caller.url('/source.wav') },
      analyses: ['metadata', 'loudness', 'transcode', 'peaks', 'bpm', 'key'],
      outputs: {
        transcode: { putUrl: caller.url(`/put/${jobId}.opus`), format: 'opus', bitrateKbps: 128, targetLufs: -14 },
        peaks: {
          format: 'audiowaveform-dat',
          levels: [
            { zoom: 256, putUrl: caller.url(`/put/${jobId}-256.dat`) },
            { zoom: 1024, putUrl: caller.url(`/put/${jobId}-1024.dat`) },
            { zoom: 4096, putUrl: caller.url(`/put/${jobId}-4096.dat`) },
          ],
        },
      },
      callback: { url: caller.url('/callback') },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { 'content-type': 'application/json', 'x-audiosonde-signature': signPayload(SECRET, payload) },
      payload,
    });
    return res.statusCode;
  };

  const started = Date.now();
  let submitted = 0;
  for (let wave = 1; wave <= WAVES; wave += 1) {
    const t0 = Date.now();
    const codes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => submit(`wave${wave}-job${i}`)),
    );
    if (codes.some((c) => c !== 202)) throw new Error(`submission rejected: ${codes.join(',')}`);
    submitted += CONCURRENCY;
    await caller.waitForCallbacks(submitted, 10 * 60 * 1000);
    console.log(`wave ${wave}: ${CONCURRENCY} jobs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  clearInterval(sampler);

  const statuses = caller.callbacks.map((cb) => cb.body['status']);
  const failures = statuses.filter((s) => s !== 'done');
  console.log('---');
  console.log(`jobs: ${submitted} submitted, ${statuses.length} callbacks, statuses: ${[...new Set(statuses)].join(',')}`);
  if (failures.length > 0) {
    for (const cb of caller.callbacks.filter((c) => c.body['status'] !== 'done')) {
      console.log(`  ${String(cb.body['jobId'])}: ${JSON.stringify(cb.body['errors'])}`);
    }
  }
  console.log(`concurrency: ${CONCURRENCY}, waves: ${WAVES}`);
  console.log(`wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`node RSS: baseline ${(baseline / 1e6).toFixed(0)} MB, peak ${(peakRss / 1e6).toFixed(0)} MB`);
  console.log('note: + one ffmpeg/ffprobe/audiowaveform subprocess per running job (cgroup-visible)');

  await app.close();
  await caller.stop();
  await rm(tmpRoot, { recursive: true, force: true });
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
