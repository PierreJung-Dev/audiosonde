import { execa } from 'execa';
import { JobFailure } from '../errors.js';

/**
 * EBU R128 measurement via ffmpeg's `loudnorm` filter (measurement pass:
 * decode to null muxer, parse the JSON block the filter prints on stderr).
 * The `input_*` fields are properties of the INPUT only — they do not depend
 * on normalization targets — so one memoized measurement per job serves both
 * the `loudness` analyzer and `transcode`'s two-pass normalization.
 */

export interface LoudnessMeasurement {
  /** Integrated loudness (LUFS). Null for e.g. digital silence (-inf). */
  readonly inputI: number | null;
  /** True peak (dBTP). */
  readonly inputTp: number | null;
  /** Loudness range (LU). */
  readonly inputLra: number | null;
  /** Gating threshold (LUFS) — needed by loudnorm's second pass. */
  readonly inputThresh: number | null;
}

export interface MeasureOptions {
  readonly ffmpegPath: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

function finiteOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Extract the last JSON object loudnorm printed on stderr. */
export function parseLoudnormJson(stderr: string): Record<string, string> {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new JobFailure('ANALYSIS_FAILED', 'loudnorm printed no measurement JSON', {
      retryable: false,
    });
  }
  try {
    return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  } catch {
    throw new JobFailure('ANALYSIS_FAILED', 'loudnorm measurement JSON is unparseable', {
      retryable: false,
    });
  }
}

export interface LoudnormTargets {
  readonly I: number;
  readonly TP: number;
  readonly LRA: number;
}

export interface TargetedMeasurement extends LoudnessMeasurement {
  /**
   * loudnorm's `target_offset` for THESE targets — the residual gain the
   * second pass must apply on top of the linear gain. Target-dependent,
   * which is why normalization runs its own measurement pass.
   */
  readonly targetOffset: number | null;
}

async function runMeasurement(
  path: string,
  filter: string,
  options: MeasureOptions,
): Promise<Record<string, string>> {
  const result = await execa(
    options.ffmpegPath,
    ['-hide_banner', '-nostats', '-i', path, '-af', filter, '-f', 'null', '-'],
    { reject: false, timeout: options.timeoutMs, cancelSignal: options.signal },
  );

  if (result.timedOut) {
    throw new JobFailure('TIMEOUT', 'loudness measurement timed out', { retryable: true });
  }
  if (result.failed || result.exitCode !== 0) {
    const tail = (result.stderr ?? '').trim().split('\n').slice(-2).join(' ');
    throw new JobFailure('UNSUPPORTED_FORMAT', `ffmpeg could not decode the source: ${tail}`, {
      retryable: false,
    });
  }

  return parseLoudnormJson(result.stderr ?? '');
}

function toMeasurement(json: Record<string, string>): LoudnessMeasurement {
  return {
    inputI: finiteOrNull(json['input_i']),
    inputTp: finiteOrNull(json['input_tp']),
    inputLra: finiteOrNull(json['input_lra']),
    inputThresh: finiteOrNull(json['input_thresh']),
  };
}

/** Measurement with loudnorm's default targets (the `loudness` analyzer). */
export async function measureLoudness(
  path: string,
  options: MeasureOptions,
): Promise<LoudnessMeasurement> {
  return toMeasurement(await runMeasurement(path, 'loudnorm=print_format=json', options));
}

/** First pass of two-pass normalization: measured against the REAL targets. */
export async function measureLoudnessWithTargets(
  path: string,
  targets: LoudnormTargets,
  options: MeasureOptions,
): Promise<TargetedMeasurement> {
  const json = await runMeasurement(
    path,
    `loudnorm=I=${targets.I}:TP=${targets.TP}:LRA=${targets.LRA}:print_format=json`,
    options,
  );
  return { ...toMeasurement(json), targetOffset: finiteOrNull(json['target_offset']) };
}
