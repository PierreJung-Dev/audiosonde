import type { Analyzer, AnalyzerContext } from './types.js';
import type { ProbeData } from '../media/probe.js';

/**
 * `metadata` analyzer (contract fragment `result.metadata`):
 * duration, sample rate, channels, bit depth, bitrate, container/codec,
 * embedded tags. All facts come from the shared ffprobe pass — except
 * `container`, which is the magic-bytes detection from fetch time: it is
 * byte-derived and stable across ffmpeg versions (ffprobe's `format_name`
 * strings like "mov,mp4,m4a,3gp,3g2,mj2" are neither).
 */

export interface MetadataResult {
  readonly durationMs: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  /** Null for codecs without a fixed sample depth (mp3, vorbis, opus …). */
  readonly bitDepth: number | null;
  readonly bitrateKbps: number | null;
  readonly container: string;
  readonly codec: string | null;
  /** Embedded tags (ID3, Vorbis comments …), keys lowercased. May be {}. */
  readonly tags: Record<string, string>;
}

function toInt(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function durationMsOf(probe: ProbeData): number | null {
  const raw = probe.format.duration ?? probe.audioStream.duration;
  if (raw === undefined) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function bitDepthOf(probe: ProbeData): number | null {
  const raw = toInt(probe.audioStream.bits_per_raw_sample);
  if (raw !== null) return raw;
  return toInt(probe.audioStream.bits_per_sample);
}

function bitrateKbpsOf(probe: ProbeData): number | null {
  const bps = toInt(probe.format.bit_rate) ?? toInt(probe.audioStream.bit_rate);
  return bps === null ? null : Math.round(bps / 1000);
}

function lowercaseTags(...sources: (Record<string, string> | undefined)[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      tags[key.toLowerCase()] = String(value);
    }
  }
  return tags;
}

export const metadataAnalyzer: Analyzer = {
  name: 'metadata',
  algoVersion: 1,
  async run(ctx: AnalyzerContext): Promise<MetadataResult> {
    const probe = await ctx.probe();
    return {
      durationMs: durationMsOf(probe),
      sampleRate: toInt(probe.audioStream.sample_rate),
      channels: toInt(probe.audioStream.channels),
      bitDepth: bitDepthOf(probe),
      bitrateKbps: bitrateKbpsOf(probe),
      container: ctx.container,
      codec: probe.audioStream.codec_name ?? null,
      // Stream tags first, format tags win on collision (ffprobe places
      // Vorbis comments on the stream, ID3 on the format).
      tags: lowercaseTags(probe.audioStream.tags, probe.format.tags),
    };
  },
};
