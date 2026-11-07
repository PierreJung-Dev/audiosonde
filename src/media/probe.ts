import { execa } from 'execa';
import { JobFailure } from '../errors.js';

/**
 * ffprobe wrapper: one probe per job, memoized by the runner and shared by
 * every analyzer that needs stream facts (metadata, loudness, transcode,
 * peaks). Invoked with argument arrays, never shell strings; stderr is
 * captured for error reporting.
 *
 * A file that ffprobe cannot parse, or that has no audio stream, is
 * `UNSUPPORTED_FORMAT` — a structured job error, never a crash.
 */

export interface ProbeStream {
  readonly index?: number;
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
  readonly bits_per_sample?: number;
  readonly bits_per_raw_sample?: string;
  readonly bit_rate?: string;
  readonly duration?: string;
  readonly tags?: Record<string, string>;
}

export interface ProbeFormat {
  readonly format_name?: string;
  readonly duration?: string;
  readonly bit_rate?: string;
  readonly tags?: Record<string, string>;
}

export interface ProbeData {
  readonly format: ProbeFormat;
  readonly streams: readonly ProbeStream[];
  /** The first audio stream (guaranteed present). */
  readonly audioStream: ProbeStream;
}

export interface ProbeOptions {
  readonly ffprobePath: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

function trimStderr(stderr: string): string {
  const text = stderr.trim().split('\n').slice(-3).join(' ');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export async function probeFile(path: string, options: ProbeOptions): Promise<ProbeData> {
  const result = await execa(
    options.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    {
      reject: false,
      timeout: options.timeoutMs,
      cancelSignal: options.signal,
      stripFinalNewline: false,
    },
  );

  if (result.timedOut || result.isCanceled) {
    throw new JobFailure(
      'TIMEOUT',
      result.timedOut ? 'ffprobe timed out' : 'ffprobe aborted at the job deadline',
      { retryable: true },
    );
  }
  if (result.failed || result.exitCode !== 0) {
    throw new JobFailure(
      'UNSUPPORTED_FORMAT',
      `ffprobe could not parse the source: ${trimStderr(result.stderr ?? '')}`,
      { retryable: false },
    );
  }

  let parsed: { format?: ProbeFormat; streams?: ProbeStream[] };
  try {
    parsed = JSON.parse(result.stdout) as { format?: ProbeFormat; streams?: ProbeStream[] };
  } catch {
    throw new JobFailure('ANALYSIS_FAILED', 'ffprobe produced unparseable output', {
      retryable: false,
    });
  }

  const streams = parsed.streams ?? [];
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  if (audioStream === undefined) {
    throw new JobFailure('UNSUPPORTED_FORMAT', 'source contains no audio stream', {
      retryable: false,
    });
  }

  return { format: parsed.format ?? {}, streams, audioStream };
}
