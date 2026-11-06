import { execa } from 'execa';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCadence, makeClickTrack } from '../bench/lib/synthesis.js';
import { PC_NAMES } from '../bench/lib/notes.js';
import { writeWavS16 } from '../bench/lib/wav.js';

/**
 * ffmpeg-synthesized test fixtures, generated at test bootstrap (vitest
 * globalSetup) into the gitignored `test/.fixtures/` — NO audio is ever
 * committed (licensing policy rule 4). A manifest of the spec list keeps the
 * cache honest: changing a spec regenerates everything.
 */

export const FIXTURE_DIR = fileURLToPath(new URL('./.fixtures', import.meta.url));

export const FIXTURES = {
  wav16: 'sine-44100-s16-stereo.wav',
  wav24: 'sine-48000-s24-mono.wav',
  wav8: 'noise-8000-u8-mono.wav',
  flac: 'sine-44100-s16-stereo.flac',
  mp3: 'sine-44100-stereo.mp3',
  ogg: 'sine-48000-vorbis-stereo.ogg',
  /** 3 s of pink noise — loud enough for meaningful loudness/peaks (M3/M4). */
  noiseWav: 'noise-44100-s16-stereo-3s.wav',
} as const;

export function fixturePath(name: (typeof FIXTURES)[keyof typeof FIXTURES]): string {
  return join(FIXTURE_DIR, name);
}

const SINE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];
const TAGS = ['-metadata', 'title=Fixture Sine', '-metadata', 'artist=audiosonde'];

interface FixtureSpec {
  readonly file: string;
  readonly args: readonly string[];
}

const SPECS: readonly FixtureSpec[] = [
  { file: FIXTURES.wav16, args: [...SINE, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le'] },
  { file: FIXTURES.wav24, args: [...SINE, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s24le'] },
  {
    file: FIXTURES.wav8,
    args: ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=1:seed=42', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_u8'],
  },
  { file: FIXTURES.flac, args: [...SINE, '-ac', '2', '-ar', '44100', '-c:a', 'flac', ...TAGS] },
  {
    file: FIXTURES.mp3,
    args: [...SINE, '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', ...TAGS],
  },
  {
    // Native (experimental) vorbis encoder: present in EVERY ffmpeg build,
    // unlike libvorbis (brew's build lacks it). It only does stereo.
    file: FIXTURES.ogg,
    args: [...SINE, '-ac', '2', '-ar', '48000', '-c:a', 'vorbis', '-strict', 'experimental', ...TAGS],
  },
  {
    file: FIXTURES.noiseWav,
    args: ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=3:seed=42:amplitude=0.5', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le'],
  },
];

/**
 * M5 accuracy-floor fixtures: synthesized in-process (bench/lib/synthesis.ts),
 * ground truth by construction — click tracks at exact BPMs and cadences in
 * all 24 keys. The 87/174 pair covers the half/double ambiguity.
 */
export const BPM_FIXTURES: ReadonlyArray<{ file: string; bpm: number; noise: boolean }> = [
  { file: 'click-87.wav', bpm: 87, noise: false },
  { file: 'click-120.wav', bpm: 120, noise: false },
  { file: 'click-128.5.wav', bpm: 128.5, noise: false },
  { file: 'click-174.wav', bpm: 174, noise: false },
  { file: 'click-120-noise.wav', bpm: 120, noise: true },
];

export const KEY_FIXTURES: ReadonlyArray<{ file: string; key: string; scale: 'major' | 'minor' }> = Array.from(
  { length: 12 },
  (_, pc) => pc,
).flatMap((pc) =>
  (['major', 'minor'] as const).map((scale) => ({
    file: `cadence-${(PC_NAMES[pc] ?? 'C').replace('#', 's')}-${scale}.wav`,
    key: PC_NAMES[pc] ?? 'C',
    scale,
  })),
);

const SYNTH_VERSION = 'm5-synth-v1';
const MANIFEST = join(FIXTURE_DIR, 'manifest.json');

export async function generateFixtures(): Promise<void> {
  const manifest = createHash('sha256')
    .update(JSON.stringify({ SPECS, BPM_FIXTURES, KEY_FIXTURES, SYNTH_VERSION }))
    .digest('hex');
  const existing = await readFile(MANIFEST, 'utf8').then(
    (t) => t,
    () => null,
  );
  if (existing === manifest) return;

  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  for (const spec of SPECS) {
    await execa('ffmpeg', ['-y', '-v', 'error', ...spec.args, join(FIXTURE_DIR, spec.file)], {
      timeout: 60_000,
    });
  }
  for (const f of BPM_FIXTURES) {
    writeWavS16(join(FIXTURE_DIR, f.file), makeClickTrack(f.bpm, 25, 44100, f.noise), 44100);
  }
  for (const f of KEY_FIXTURES) {
    const pc = PC_NAMES.indexOf(f.key as (typeof PC_NAMES)[number]);
    writeWavS16(join(FIXTURE_DIR, f.file), makeCadence(pc, f.scale, 44100), 44100);
  }
  await writeFile(MANIFEST, manifest);
}
