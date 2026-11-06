import { execa } from 'execa';
import { JobFailure } from '../errors.js';

/**
 * Shared decoded-PCM window for the bpm/key analyzers (M5).
 *
 * BPM and key are properties of the musical core of a track, not of its full
 * length: both analyzers work on ONE centered window of at most
 * {@link ANALYSIS_WINDOW_SECONDS}, decoded once per job (mono, 44.1 kHz,
 * float32). This matches the 2-minute previews the M5 benchmark was measured
 * on (docs/decisions/0005) and bounds memory (~32 MB) independently of source
 * duration — a 4-hour source would otherwise decode to gigabytes.
 */

export const ANALYSIS_WINDOW_SECONDS = 180;
export const ANALYSIS_SAMPLE_RATE = 44100;

export interface PcmWindow {
  /** Mono float32 samples at {@link ANALYSIS_SAMPLE_RATE}. */
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** Offset of the window inside the source, in seconds (0 for short sources). */
  readonly startSeconds: number;
}

export interface DecodeWindowOptions {
  ffmpegPath: string;
  /** Source duration in seconds (from the shared probe); null if unknown. */
  durationSeconds: number | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function decodePcmWindow(sourcePath: string, options: DecodeWindowOptions): Promise<PcmWindow> {
  const dur = options.durationSeconds;
  const startSeconds =
    dur !== null && Number.isFinite(dur) && dur > ANALYSIS_WINDOW_SECONDS ? (dur - ANALYSIS_WINDOW_SECONDS) / 2 : 0;

  const args = ['-v', 'error'];
  if (startSeconds > 0) args.push('-ss', startSeconds.toFixed(3));
  args.push(
    '-i', sourcePath,
    '-t', String(ANALYSIS_WINDOW_SECONDS),
    '-ac', '1',
    '-ar', String(ANALYSIS_SAMPLE_RATE),
    '-f', 'f32le',
    'pipe:1',
  );

  const result = await execa(options.ffmpegPath, args, {
    reject: false,
    timeout: options.timeoutMs,
    ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    encoding: 'buffer' as const,
    maxBuffer: 48 * 1024 * 1024, // window ceiling is ~31.8 MB of f32le
  });
  if (result.timedOut) {
    throw new JobFailure('TIMEOUT', `pcm decode exceeded ${options.timeoutMs}ms`, { retryable: true });
  }
  if (result.exitCode !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    throw new JobFailure('ANALYSIS_FAILED', `pcm decode failed: ${stderr.trim().slice(0, 300) || 'ffmpeg error'}`);
  }

  const bytes = result.stdout;
  const sampleCount = Math.floor(bytes.byteLength / 4);
  if (sampleCount < ANALYSIS_SAMPLE_RATE) {
    throw new JobFailure('ANALYSIS_FAILED', 'decoded under 1 s of audio — too short for bpm/key analysis');
  }
  // f32le output matches the little-endian hosts we support; copy into an
  // aligned Float32Array (the subprocess buffer's offset is not guaranteed
  // 4-byte aligned).
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 4);
  for (let i = 0; i < sampleCount; i++) samples[i] = view.getFloat32(i * 4, true);

  return { samples, sampleRate: ANALYSIS_SAMPLE_RATE, startSeconds };
}
