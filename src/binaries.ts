import { execa } from 'execa';
import type { Config } from './config.js';

/**
 * Resolves the external subprocess binaries (ffmpeg/ffprobe/audiowaveform) and
 * their versions at boot, for reporting on /healthz and gating /readyz.
 * Missing binaries are reported as unavailable — they are not fatal in M0
 * (no analyzer runs yet); readiness tightens as analyzers land.
 */

export interface BinaryInfo {
  readonly available: boolean;
  readonly version: string | null;
}

export interface BinaryReport {
  readonly ffmpeg: BinaryInfo;
  readonly ffprobe: BinaryInfo;
  readonly audiowaveform: BinaryInfo;
}

async function probe(bin: string, args: string[], versionRe: RegExp): Promise<BinaryInfo> {
  try {
    // reject:false resolves (does not throw) even on ENOENT/spawn failure, so
    // we must inspect `failed`/`exitCode` — a missing binary is NOT available.
    const result = await execa(bin, args, { reject: false, timeout: 5000 });
    if (result.failed || result.exitCode !== 0) {
      return { available: false, version: null };
    }
    const match = versionRe.exec(`${result.stdout}\n${result.stderr}`);
    return { available: true, version: match?.[1] ?? null };
  } catch {
    return { available: false, version: null };
  }
}

export async function resolveBinaries(config: Config): Promise<BinaryReport> {
  const [ffmpeg, ffprobe, audiowaveform] = await Promise.all([
    probe(config.binaries.ffmpeg, ['-version'], /ffmpeg version (\S+)/i),
    probe(config.binaries.ffprobe, ['-version'], /ffprobe version (\S+)/i),
    probe(config.binaries.audiowaveform, ['--version'], /(\d+\.\d+\.\d+)/),
  ]);
  return { ffmpeg, ffprobe, audiowaveform };
}
