import { execa } from 'execa';
import { join } from 'node:path';
import { JobFailure } from '../errors.js';
import { uploadArtifact } from '../pipeline/upload.js';
import type { Analyzer, AnalyzerContext } from './types.js';

/**
 * `peaks` analyzer: waveform peak data via BBC `audiowaveform`, one artifact
 * per requested zoom level (a .dat/json file holds exactly one resolution —
 * see docs/decisions/0004 and docs/peaks-format.md for the consumer-side
 * decode).
 *
 * The source is first decoded to an intermediate PCM wav with ffmpeg, so
 * every container ffmpeg decodes (aiff, mp4, asf, …) works even though
 * audiowaveform itself reads only wav/flac/ogg/opus/mp3.
 */

export interface PeaksLevelResult {
  readonly zoom: number;
  readonly byteSize: number;
}

export interface PeaksResult {
  readonly uploaded: boolean;
  readonly format: 'audiowaveform-dat' | 'json';
  readonly zoomLevels: number[];
  /** Total bytes across all uploaded artifacts. */
  readonly byteSize: number;
  readonly levels: PeaksLevelResult[];
  readonly bits: 8 | 16;
}

const CONTENT_TYPES = { 'audiowaveform-dat': 'application/octet-stream', json: 'application/json' } as const;

function tail(stderr: string | undefined): string {
  return (stderr ?? '').trim().split('\n').slice(-2).join(' ');
}

export const peaksAnalyzer: Analyzer = {
  name: 'peaks',
  algoVersion: 1,
  async run(ctx: AnalyzerContext): Promise<PeaksResult> {
    const output = ctx.job.outputs?.peaks;
    if (output === undefined) {
      // Unreachable: submission validation enforces the slot (422).
      throw new JobFailure('ANALYSIS_FAILED', 'peaks requested without an output slot', {
        retryable: false,
      });
    }
    const bits = output.bits ?? 8;

    // Intermediate PCM decode (any ffmpeg-decodable container → wav).
    const wavPath = join(ctx.tmpDir, 'peaks-input.wav');
    const decode = await execa(
      ctx.config.binaries.ffmpeg,
      ['-y', '-v', 'error', '-i', ctx.sourcePath, '-vn', '-c:a', 'pcm_s16le', '-f', 'wav', wavPath],
      { reject: false, timeout: ctx.config.analyzerTimeoutMs, cancelSignal: ctx.signal },
    );
    if (decode.timedOut) {
      throw new JobFailure('TIMEOUT', 'peaks decode timed out', { analyzer: 'peaks', retryable: true });
    }
    if (decode.failed || decode.exitCode !== 0) {
      throw new JobFailure('ANALYSIS_FAILED', `ffmpeg decode for peaks failed: ${tail(decode.stderr)}`, {
        analyzer: 'peaks',
        retryable: false,
      });
    }

    const extension = output.format === 'json' ? 'json' : 'dat';
    const levels: PeaksLevelResult[] = [];

    for (const level of output.levels) {
      const outPath = join(ctx.tmpDir, `peaks-${level.zoom}.${extension}`);
      const result = await execa(
        ctx.config.binaries.audiowaveform,
        [
          '--input-format', 'wav',
          '-i', wavPath,
          '--output-format', extension,
          '-o', outPath,
          '-z', String(level.zoom),
          '-b', String(bits),
          '-q', // quiet: progress output is noise in logs
        ],
        { reject: false, timeout: ctx.config.analyzerTimeoutMs, cancelSignal: ctx.signal },
      );
      if (result.timedOut) {
        throw new JobFailure('TIMEOUT', `peaks generation timed out at zoom ${level.zoom}`, {
          analyzer: 'peaks',
          retryable: true,
        });
      }
      if (result.failed || result.exitCode !== 0) {
        throw new JobFailure(
          'ANALYSIS_FAILED',
          `audiowaveform failed at zoom ${level.zoom}: ${tail(result.stderr)}`,
          { analyzer: 'peaks', retryable: false },
        );
      }

      const { byteSize } = await uploadArtifact(level.putUrl, outPath, {
        contentType: CONTENT_TYPES[output.format],
        policy: ctx.policy,
        signal: ctx.signal,
      });
      levels.push({ zoom: level.zoom, byteSize });
    }

    return {
      uploaded: true,
      format: output.format,
      zoomLevels: levels.map((l) => l.zoom),
      byteSize: levels.reduce((sum, l) => sum + l.byteSize, 0),
      levels,
      bits,
    };
  },
};
