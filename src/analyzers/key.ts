import type { Analyzer } from './types.js';
import { JobFailure } from '../errors.js';
import { getEssentia, withVector } from '../media/essentia.js';

/**
 * `key` analyzer — essentia.js KeyExtractor with the `edma` profile over the
 * shared analysis window. Measured winner of the M5 benchmark
 * (docs/decisions/0005): MIREX 0.650 / 57.6% exact / 63.9% exact-or-relative
 * on GiantSteps key (n=604), vs 0.585 (krumhansl) and 0.464 (temperley).
 *
 * `confidence` is the extractor's key strength (0..1) passed through — it
 * calibrates: strength < 0.55 was ~never exact on GiantSteps, ≥ 0.7 was exact
 * 61% of the time (see the ADR).
 *
 * Tonic names are normalized to sharps (C, C#, D, … B) so callers get one
 * stable 12-name vocabulary.
 */

const SHARP_NORMALIZE: Record<string, string> = {
  Ab: 'G#',
  Bb: 'A#',
  Cb: 'B',
  Db: 'C#',
  Eb: 'D#',
  Fb: 'E',
  Gb: 'F#',
  'B#': 'C',
  'E#': 'F',
};

export interface KeyResult {
  key: string;
  scale: 'major' | 'minor';
  confidence: number;
}

export const keyAnalyzer: Analyzer = {
  name: 'key',
  algoVersion: 1,
  async run(ctx): Promise<KeyResult> {
    const { samples } = await ctx.pcmWindow();
    const essentia = await getEssentia();

    const res = withVector(essentia, samples, (vec) =>
      essentia.KeyExtractor(vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'edma', 44100, 0.0001, 440, 'cosine', 'hann'),
    );

    const key = SHARP_NORMALIZE[res.key] ?? res.key;
    if (!/^[A-G]#?$/.test(key)) {
      throw new JobFailure('ANALYSIS_FAILED', `key detector returned unexpected tonic ${JSON.stringify(res.key)}`, {
        analyzer: 'key',
      });
    }
    const scale = res.scale === 'minor' ? 'minor' : 'major';
    const confidence = Math.round(Math.min(1, Math.max(0, res.strength)) * 100) / 100;

    return { key, scale, confidence };
  },
};
