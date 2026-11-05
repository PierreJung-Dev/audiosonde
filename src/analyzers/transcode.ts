import { execa } from 'execa';
import { join } from 'node:path';
import { JobFailure } from '../errors.js';
import { measureLoudnessWithTargets } from '../media/loudness.js';
import { uploadArtifact } from '../pipeline/upload.js';
import type { Analyzer, AnalyzerContext } from './types.js';

/**
 * `transcode` analyzer: MP3 or Opus derivative (NOTHING else, ever — see
 * docs/licensing-policy.md rule 3: MP3 patents expired, Opus is royalty-free,
 * AAC is never permitted), optionally loudness-normalized to `targetLufs`
 * with a two-pass `loudnorm` (measurement pass shared with the `loudness`
 * analyzer; second pass linear, true-peak ceiling -1.5 dBTP), uploaded to the
 * caller's signed PUT URL.
 */

export interface TranscodeResult {
  readonly uploaded: boolean;
  readonly format: 'mp3' | 'opus';
  readonly bitrateKbps: number;
  readonly byteSize: number;
  readonly normalizedToLufs: number | null;
}

/** Content types sent on the signed PUT (documented in the contract). */
const CONTENT_TYPES = { mp3: 'audio/mpeg', opus: 'audio/ogg' } as const;

/** loudnorm second-pass constants (see docs/decisions/0003). */
const TRUE_PEAK_CEILING = -1.5;
const TARGET_LRA = 11;

export const transcodeAnalyzer: Analyzer = {
  name: 'transcode',
  algoVersion: 1,
  async run(ctx: AnalyzerContext): Promise<TranscodeResult> {
    const output = ctx.job.outputs?.transcode;
    if (output === undefined) {
      // Unreachable: submission validation enforces the slot (422).
      throw new JobFailure('ANALYSIS_FAILED', 'transcode requested without an output slot', {
        retryable: false,
      });
    }

    const probe = await ctx.probe();
    const sourceRate = Number(probe.audioStream.sample_rate ?? '44100') || 44100;

    const args: string[] = ['-y', '-v', 'error', '-i', ctx.sourcePath, '-vn'];

    if (output.targetLufs !== undefined) {
      // Two-pass loudnorm: the first pass must run with the REAL targets so
      // its target_offset is valid for the second (see docs/decisions/0003).
      const targets = { I: output.targetLufs, TP: TRUE_PEAK_CEILING, LRA: TARGET_LRA };
      const m = await measureLoudnessWithTargets(ctx.sourcePath, targets, {
        ffmpegPath: ctx.config.binaries.ffmpeg,
        timeoutMs: ctx.config.analyzerTimeoutMs,
        signal: ctx.signal,
      });
      if (m.inputI === null || m.inputTp === null || m.inputLra === null || m.inputThresh === null) {
        throw new JobFailure(
          'ANALYSIS_FAILED',
          'source loudness is unmeasurable (digital silence?); cannot normalize',
          { analyzer: 'transcode', retryable: false },
        );
      }
      args.push(
        '-af',
        `loudnorm=I=${targets.I}:TP=${targets.TP}:LRA=${targets.LRA}` +
          `:measured_I=${m.inputI}:measured_TP=${m.inputTp}` +
          `:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}` +
          `:offset=${m.targetOffset ?? 0}:linear=true`,
      );
    }

    let outPath: string;
    if (output.format === 'mp3') {
      // loudnorm outputs 192 kHz; mp3 caps at 48 kHz — always pin the rate.
      const rate = Math.min(sourceRate, 48000);
      args.push('-ar', String(rate), '-c:a', 'libmp3lame', '-b:a', `${output.bitrateKbps}k`, '-f', 'mp3');
      outPath = join(ctx.tmpDir, 'derivative.mp3');
    } else {
      args.push('-ar', '48000', '-c:a', 'libopus', '-b:a', `${output.bitrateKbps}k`, '-f', 'opus');
      outPath = join(ctx.tmpDir, 'derivative.opus');
    }
    args.push(outPath);

    const result = await execa(ctx.config.binaries.ffmpeg, args, {
      reject: false,
      timeout: ctx.config.analyzerTimeoutMs,
      cancelSignal: ctx.signal,
    });
    if (result.timedOut) {
      throw new JobFailure('TIMEOUT', 'transcode timed out', { analyzer: 'transcode', retryable: true });
    }
    if (result.failed || result.exitCode !== 0) {
      const tail = (result.stderr ?? '').trim().split('\n').slice(-2).join(' ');
      throw new JobFailure('ANALYSIS_FAILED', `ffmpeg transcode failed: ${tail}`, {
        analyzer: 'transcode',
        retryable: false,
      });
    }

    const { byteSize } = await uploadArtifact(output.putUrl, outPath, {
      contentType: CONTENT_TYPES[output.format],
      policy: ctx.policy,
      signal: ctx.signal,
    });

    return {
      uploaded: true,
      format: output.format,
      bitrateKbps: output.bitrateKbps,
      byteSize,
      normalizedToLufs: output.targetLufs ?? null,
    };
  },
};
