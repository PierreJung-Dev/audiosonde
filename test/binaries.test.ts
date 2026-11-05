import { describe, expect, it } from 'vitest';
import { resolveBinaries } from '../src/binaries.js';
import { testConfig } from './helpers.js';

describe('resolveBinaries', () => {
  it('reports a missing binary as unavailable (not a crash)', async () => {
    const report = await resolveBinaries({
      ...testConfig,
      binaries: {
        ffmpeg: 'audiosonde-no-such-binary-aaa',
        ffprobe: 'audiosonde-no-such-binary-bbb',
        audiowaveform: 'audiosonde-no-such-binary-ccc',
      },
    });
    expect(report.ffmpeg).toEqual({ available: false, version: null });
    expect(report.ffprobe).toEqual({ available: false, version: null });
    expect(report.audiowaveform).toEqual({ available: false, version: null });
  });
});
