import { tmpdir } from 'node:os';
import type { BinaryReport } from '../src/binaries.js';
import type { Config } from '../src/config.js';
import type { AnalyzerContext } from '../src/analyzers/types.js';
import type { SniffedContainer } from '../src/pipeline/sniff.js';
import { probeFile, type ProbeData } from '../src/media/probe.js';
import { measureLoudness, type LoudnessMeasurement } from '../src/media/loudness.js';
import { decodePcmWindow, type PcmWindow } from '../src/media/pcm.js';
import { publicAddressPolicy, type AddressPolicy } from '../src/net/ssrf.js';

export const TEST_SECRET = 'test-secret';

export const testConfig: Config = {
  signingSecret: TEST_SECRET,
  acceptedSecrets: [TEST_SECRET],
  host: '127.0.0.1',
  port: 0,
  maxConcurrentJobs: 4,
  maxSourceBytes: 1024,
  maxDurationMs: 1000,
  jobTimeoutMs: 1000,
  analyzerTimeoutMs: 1000,
  signatureToleranceSeconds: 300,
  metricsEnabled: true,
  binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', audiowaveform: 'audiowaveform' },
};

export const fakeBinaries: BinaryReport = {
  ffmpeg: { available: true, version: '6.1.1' },
  ffprobe: { available: true, version: '6.1.1' },
  audiowaveform: { available: true, version: '1.10.3' },
};

export function fakeResolveBinaries(): Promise<BinaryReport> {
  return Promise.resolve(fakeBinaries);
}

/**
 * A real AnalyzerContext over a local file (no HTTP), for analyzer unit and
 * golden tests. Uses the actual binaries from PATH and a generous timeout.
 */
export function makeAnalyzerContext(
  sourcePath: string,
  container: SniffedContainer,
  overrides: {
    job?: Partial<AnalyzerContext['job']>;
    config?: Partial<Config>;
    tmpDir?: string;
    policy?: AddressPolicy;
  } = {},
): AnalyzerContext {
  const config: Config = { ...testConfig, analyzerTimeoutMs: 30_000, ...overrides.config };
  const signal = new AbortController().signal;
  let probeMemo: Promise<ProbeData> | undefined;
  let loudnessMemo: Promise<LoudnessMeasurement> | undefined;
  let pcmMemo: Promise<PcmWindow> | undefined;
  const getProbe = (): Promise<ProbeData> =>
    (probeMemo ??= probeFile(sourcePath, {
      ffprobePath: config.binaries.ffprobe,
      timeoutMs: config.analyzerTimeoutMs,
      signal,
    }));
  return {
    job: {
      jobId: 'test-job',
      source: { url: 'https://source.invalid/fixture' },
      analyses: ['metadata'],
      callback: { url: 'https://callback.invalid/cb' },
      ...overrides.job,
    },
    sourcePath,
    tmpDir: overrides.tmpDir ?? tmpdir(),
    container,
    config,
    signal,
    policy: overrides.policy ?? publicAddressPolicy,
    probe: getProbe,
    measureLoudness: () =>
      (loudnessMemo ??= measureLoudness(sourcePath, {
        ffmpegPath: config.binaries.ffmpeg,
        timeoutMs: config.analyzerTimeoutMs,
        signal,
      })),
    pcmWindow: () =>
      (pcmMemo ??= (async (): Promise<PcmWindow> => {
        const probe = await getProbe();
        const raw = probe.format.duration ?? probe.audioStream.duration;
        const parsed = raw === undefined ? NaN : Number(raw);
        return decodePcmWindow(sourcePath, {
          ffmpegPath: config.binaries.ffmpeg,
          durationSeconds: Number.isFinite(parsed) ? parsed : null,
          timeoutMs: config.analyzerTimeoutMs,
          signal,
        });
      })()),
  };
}
