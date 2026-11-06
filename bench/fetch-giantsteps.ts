/**
 * Fetches the GiantSteps reference sets (key + tempo) for the M5 benchmark.
 *
 * Annotations come from the GiantSteps GitHub repositories (open annotations).
 * Audio (2-minute Beatport preview mp3s) is downloaded at bench time from the
 * dataset maintainers' mirror at JKU (cp.jku.at), falling back to Beatport's
 * public preview CDN, and every file is verified against the per-file MD5
 * shipped with the dataset. Audio is cached under bench/.data/ and is NEVER
 * committed or redistributed (see docs/licensing-policy.md, rule 4).
 *
 * Usage: pnpm bench:fetch [--limit N]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { parseKeyAnnotation } from './lib/notes.js';

const DATA = 'bench/.data/giantsteps';
const REPOS = join(DATA, 'repos');
const AUDIO = join(DATA, 'audio');

const TARBALLS = [
  {
    name: 'key',
    url: 'https://codeload.github.com/GiantSteps/giantsteps-key-dataset/tar.gz/refs/heads/master',
    dir: 'giantsteps-key-dataset-master',
  },
  {
    name: 'tempo',
    url: 'https://codeload.github.com/GiantSteps/giantsteps-tempo-dataset/tar.gz/refs/heads/master',
    dir: 'giantsteps-tempo-dataset-master',
  },
] as const;

const PRIMARY_BASE = 'https://www.cp.jku.at/datasets/giantsteps/backup/';
const FALLBACK_BASE = 'https://geo-samples.beatport.com/lofi/';

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number.parseInt(process.argv[limitArg + 1] ?? '', 10) : Infinity;

mkdirSync(REPOS, { recursive: true });
mkdirSync(AUDIO, { recursive: true });

async function ensureRepos(): Promise<void> {
  for (const t of TARBALLS) {
    const marker = join(REPOS, t.dir, 'README');
    if (existsSync(marker)) continue;
    console.log(`downloading annotations: ${t.name} dataset…`);
    const res = await fetch(t.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`annotation tarball ${t.name}: HTTP ${res.status}`);
    const tarPath = join(REPOS, `${t.name}.tar.gz`);
    writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
    await execa('tar', ['-xzf', tarPath, '-C', REPOS]);
  }
}

interface KeyEntry {
  id: string;
  file: string;
  key: string;
  scale: 'major' | 'minor';
}
interface TempoEntry {
  id: string;
  file: string;
  bpm: number;
}

function md5Of(path: string): string {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function expectedMd5(repoDir: string, id: string): string | null {
  const p = join(REPOS, repoDir, 'md5', `${id}.md5`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim().toLowerCase();
}

async function downloadTrack(id: string, md5: string | null): Promise<boolean> {
  const dest = join(AUDIO, `${id}.mp3`);
  const ok = (p: string) => md5 === null || md5Of(p) === md5;
  if (existsSync(dest) && ok(dest)) return true;
  for (const base of [PRIMARY_BASE, FALLBACK_BASE]) {
    try {
      const res = await fetch(`${base}${id}.mp3`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) continue;
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      if (ok(dest)) return true;
    } catch {
      // try next source
    }
  }
  return false;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await fn(item);
      }
    }),
  );
}

await ensureRepos();

// --- collect wanted tracks from annotations ---------------------------------
const keyRepo = 'giantsteps-key-dataset-master';
const tempoRepo = 'giantsteps-tempo-dataset-master';

const keyWanted: Array<Omit<KeyEntry, 'file'>> = [];
for (const f of readdirSync(join(REPOS, keyRepo, 'annotations', 'key')).sort()) {
  if (!f.endsWith('.key')) continue;
  const id = f.slice(0, -'.key'.length); // e.g. 1004923.LOFI
  const parsed = parseKeyAnnotation(readFileSync(join(REPOS, keyRepo, 'annotations', 'key', f), 'utf8'));
  if (!parsed) continue; // skip non-single-key annotations
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  keyWanted.push({ id, key: names[parsed.pc] ?? 'C', scale: parsed.scale });
}

const tempoWanted: Array<Omit<TempoEntry, 'file'>> = [];
const tempoAnnDir = join(REPOS, tempoRepo, 'annotations_v2', 'tempo');
for (const f of readdirSync(tempoAnnDir).sort()) {
  if (!f.endsWith('.bpm')) continue;
  const id = f.slice(0, -'.bpm'.length);
  const bpm = Number.parseFloat(readFileSync(join(tempoAnnDir, f), 'utf8'));
  if (!Number.isFinite(bpm) || bpm <= 0) continue;
  tempoWanted.push({ id, bpm });
}

const keySlice = keyWanted.slice(0, limit);
const tempoSlice = tempoWanted.slice(0, limit);

// --- download audio ----------------------------------------------------------
const tasks = new Map<string, string | null>(); // id -> expected md5
for (const e of keySlice) tasks.set(e.id, expectedMd5(keyRepo, e.id));
for (const e of tempoSlice) {
  if (!tasks.has(e.id)) tasks.set(e.id, expectedMd5(tempoRepo, e.id));
}

const got = new Set<string>();
let done = 0;
let failed = 0;
await pool([...tasks.entries()], 6, async ([id, md5]) => {
  if (await downloadTrack(id, md5)) got.add(id);
  else failed++;
  done++;
  if (done % 50 === 0) console.log(`audio: ${done}/${tasks.size} (${failed} failed)`);
});

// --- write manifests (verified audio only) -----------------------------------
const keyManifest: KeyEntry[] = keySlice
  .filter((e) => got.has(e.id))
  .map((e) => ({ ...e, file: join(AUDIO, `${e.id}.mp3`) }));
const tempoManifest: TempoEntry[] = tempoSlice
  .filter((e) => got.has(e.id))
  .map((e) => ({ ...e, file: join(AUDIO, `${e.id}.mp3`) }));

writeFileSync(join(DATA, 'manifest-key.json'), JSON.stringify(keyManifest, null, 2));
writeFileSync(join(DATA, 'manifest-tempo.json'), JSON.stringify(tempoManifest, null, 2));

console.log(
  `giantsteps-key: ${keyManifest.length}/${keySlice.length} tracks with verified audio\n` +
    `giantsteps-tempo: ${tempoManifest.length}/${tempoSlice.length} tracks with verified audio\n` +
    `audio files on disk: ${got.size}, failed downloads: ${failed}`,
);
