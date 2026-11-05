import { execa } from 'execa';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const MANIFEST = join(FIXTURE_DIR, 'manifest.json');

export async function generateFixtures(): Promise<void> {
  const manifest = createHash('sha256').update(JSON.stringify(SPECS)).digest('hex');
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
  await writeFile(MANIFEST, manifest);
}
