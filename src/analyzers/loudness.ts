import type { Analyzer, AnalyzerContext } from './types.js';

/**
 * `loudness` analyzer (contract fragment `result.loudness`): EBU R128
 * integrated loudness, true peak and loudness range, from the job's shared
 * (memoized) loudnorm measurement pass.
 */

export interface LoudnessResult {
  /** Integrated loudness (LUFS); null for unmeasurable input (digital silence). */
  readonly integratedLufs: number | null;
  readonly truePeakDbtp: number | null;
  readonly loudnessRange: number | null;
}

const round2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

export const loudnessAnalyzer: Analyzer = {
  name: 'loudness',
  algoVersion: 1,
  async run(ctx: AnalyzerContext): Promise<LoudnessResult> {
    const m = await ctx.measureLoudness();
    return {
      integratedLufs: round2(m.inputI),
      truePeakDbtp: round2(m.inputTp),
      loudnessRange: round2(m.inputLra),
    };
  },
};
