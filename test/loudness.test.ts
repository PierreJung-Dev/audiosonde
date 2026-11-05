import { describe, expect, it } from 'vitest';
import { loudnessAnalyzer, type LoudnessResult } from '../src/analyzers/loudness.js';
import { parseLoudnormJson } from '../src/media/loudness.js';
import { JobFailure } from '../src/errors.js';
import { FIXTURES, fixturePath } from './fixture-gen.js';
import { makeAnalyzerContext } from './helpers.js';

/**
 * Golden bands, not exact values: BS.1770 measurement is stable across ffmpeg
 * versions, but encoder/filter revisions can move the second decimal. The
 * reference values were measured with ffmpeg 9 (brew) — bands are ±1.5 LU.
 */

async function analyze(file: string): Promise<LoudnessResult> {
  const ctx = makeAnalyzerContext(fixturePath(file), 'wav');
  return (await loudnessAnalyzer.run(ctx)) as LoudnessResult;
}

describe('loudness analyzer', () => {
  it('sine fixture: ≈ -21.8 LUFS integrated, ≈ -21.1 dBTP', async () => {
    const l = await analyze(FIXTURES.wav16);
    expect(l.integratedLufs).toBeGreaterThanOrEqual(-23.3);
    expect(l.integratedLufs).toBeLessThanOrEqual(-20.3);
    expect(l.truePeakDbtp).toBeGreaterThanOrEqual(-22.6);
    expect(l.truePeakDbtp).toBeLessThanOrEqual(-19.6);
    expect(l.loudnessRange).toBeGreaterThanOrEqual(0);
  });

  it('pink-noise fixture: ≈ -20.8 LUFS integrated, ≈ -11.8 dBTP', async () => {
    const l = await analyze(FIXTURES.noiseWav);
    expect(l.integratedLufs).toBeGreaterThanOrEqual(-22.3);
    expect(l.integratedLufs).toBeLessThanOrEqual(-19.3);
    expect(l.truePeakDbtp).toBeGreaterThanOrEqual(-13.3);
    expect(l.truePeakDbtp).toBeLessThanOrEqual(-10.3);
  });

  it('parseLoudnormJson rejects stderr without a JSON block', () => {
    expect(() => parseLoudnormJson('no json here')).toThrowError(JobFailure);
  });
});
