import type { BinaryReport } from '../src/binaries.js';
import type { Config } from '../src/config.js';

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
  signatureToleranceSeconds: 300,
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
