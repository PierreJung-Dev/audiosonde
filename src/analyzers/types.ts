import type { Config } from '../config.js';
import type { JobRequest } from '../schema/job.js';
import type { SniffedContainer } from '../pipeline/sniff.js';
import type { ProbeData } from '../media/probe.js';
import type { LoudnessMeasurement } from '../media/loudness.js';
import type { AddressPolicy } from '../net/ssrf.js';

/**
 * Analyzer module shape (see docs/architecture.md): filesystem in, JSON out.
 * One module per analyzer under `src/analyzers/`; the pipeline composes them
 * in registry order and enforces per-analyzer timeouts. Keep analyzers
 * pure-ish: no network of their own (artifact uploads go through the ctx's
 * signed PUT helpers added in M3), no state between runs.
 */

export interface AnalyzerContext {
  readonly job: JobRequest;
  /** Absolute path of the downloaded source file (inside tmpDir). */
  readonly sourcePath: string;
  /** Job-scoped scratch directory; removed after the job, always. */
  readonly tmpDir: string;
  /** Container detected from magic bytes at fetch time. */
  readonly container: SniffedContainer;
  readonly config: Config;
  /** Aborts when the overall job deadline passes. */
  readonly signal: AbortSignal;
  /** Shared ffprobe pass over the source — memoized, one probe per job. */
  probe(): Promise<ProbeData>;
  /** Shared EBU R128 measurement pass — memoized, one measurement per job. */
  measureLoudness(): Promise<LoudnessMeasurement>;
  /** SSRF address policy for analyzer uploads (signed PUT). */
  readonly policy: AddressPolicy;
}

export interface Analyzer {
  readonly name: string;
  /** Bumped on ANY behavior change (determinism contract). */
  readonly algoVersion: number;
  /** The result fragment placed at `result.<name>` in the callback. */
  run(ctx: AnalyzerContext): Promise<unknown>;
}
