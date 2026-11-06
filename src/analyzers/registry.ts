import type { Analyzer } from './types.js';
import { metadataAnalyzer } from './metadata.js';
import { noopAnalyzer } from './noop.js';

/**
 * The analyzers available in this build, in PIPELINE ORDER (earlier analyzers
 * run first; later ones may depend on their side effects — e.g. `transcode`
 * reads the `loudness` measurement when normalization is requested).
 *
 * An analysis name that is in the contract but not in this registry is
 * rejected at submission with 422 — the engine never accepts work it cannot
 * perform. The registry grows milestone by milestone (M2 metadata, M3
 * loudness + transcode, M4 peaks, M5 bpm + key).
 */
export const ANALYZERS: readonly Analyzer[] = [metadataAnalyzer, noopAnalyzer];

export const AVAILABLE_ANALYSES: ReadonlySet<string> = new Set(ANALYZERS.map((a) => a.name));

/** Reported in every callback under `engine.algoVersions`. */
export const ALGO_VERSIONS: Readonly<Record<string, number>> = Object.fromEntries(
  ANALYZERS.map((a) => [a.name, a.algoVersion]),
);

/** The registry's analyzers for a job's requested analyses, pipeline-ordered. */
export function analyzersFor(requested: readonly string[]): Analyzer[] {
  const requestedSet = new Set(requested);
  return ANALYZERS.filter((a) => requestedSet.has(a.name));
}
