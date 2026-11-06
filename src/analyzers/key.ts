import type { Analyzer } from './types.js';
import { JobFailure } from '../errors.js';
import { runKeyTask } from '../media/essentia-tasks.js';

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
 * The extraction runs in a worker thread (src/media/essentia-tasks.ts, M6):
 * same WASM, same call, same results — algoVersion stays 1.
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
    const res = await runKeyTask(samples, {
      analyzer: 'key',
      timeoutMs: ctx.config.analyzerTimeoutMs,
      signal: ctx.signal,
    });

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
