import type { Analyzer } from './types.js';
import { JobFailure } from '../errors.js';
import { getEssentia, withVector } from '../media/essentia.js';

/**
 * `bpm` analyzer — essentia.js PercivalBpmEstimator over the shared analysis
 * window. Measured winner of the M5 benchmark (docs/decisions/0005): 95.9%
 * acc2 (±2%, octave-tolerant) on GiantSteps tempo (n=661), vs 80.9% for
 * RhythmExtractor2013 and 18.3% for aubio.
 *
 * The RAW estimate is reported — deliberately no octave folding into a
 * "preferred" BPM range: folding is a genre prior (it lifted acc1 to 87% on
 * the EDM-centric GiantSteps set but would double every 80 BPM hip-hop
 * track). See the ADR for the measurements.
 *
 * Confidence = split-half agreement, calibrated on GiantSteps: estimates on
 * each half of the window are compared (±2%, octave-tolerant) with the
 * full-window estimate. Both agree → 0.9 (measured 97.5% correct), one → 0.6
 * (interpolated), none → 0.3 (measured 63.3% correct).
 */

const OCTAVE_MULTIPLES = [1, 2, 0.5, 3, 1 / 3];
const octaveAgrees = (a: number, b: number): boolean =>
  OCTAVE_MULTIPLES.some((m) => Math.abs(a - b * m) <= 0.02 * b * m);

export interface BpmResult {
  value: number;
  confidence: number;
}

export const bpmAnalyzer: Analyzer = {
  name: 'bpm',
  algoVersion: 1,
  async run(ctx): Promise<BpmResult> {
    const { samples } = await ctx.pcmWindow();
    const essentia = await getEssentia();

    const estimate = withVector(essentia, samples, (vec) => essentia.PercivalBpmEstimator(vec).bpm);
    if (!Number.isFinite(estimate) || estimate <= 0) {
      throw new JobFailure('ANALYSIS_FAILED', 'tempo estimator returned no result', { analyzer: 'bpm' });
    }

    const mid = Math.floor(samples.length / 2);
    const halves = [samples.subarray(0, mid), samples.subarray(mid)];
    const agreeing = halves.filter((half) => {
      const bpm = withVector(essentia, half, (vec) => essentia.PercivalBpmEstimator(vec).bpm);
      return Number.isFinite(bpm) && bpm > 0 && octaveAgrees(bpm, estimate);
    }).length;
    const confidence = agreeing === 2 ? 0.9 : agreeing === 1 ? 0.6 : 0.3;

    return { value: Math.round(estimate * 10) / 10, confidence };
  },
};
