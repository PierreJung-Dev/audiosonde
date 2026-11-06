/**
 * Runs the M5 BPM/key benchmark on one reference set.
 *
 * Usage: pnpm bench:run --set synthetic-bpm|synthetic-key|gs-bpm|gs-key [--limit N]
 *
 * Tracks are processed sequentially (fair per-candidate timing). mp3 sources are
 * decoded once per track to mono 44.1 kHz s16le wav with ffmpeg; decode time is
 * excluded from candidate timings. Results land in bench/results/<set>.json and
 * a markdown summary is printed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execa } from 'execa';
import {
  bpmCandidates,
  keyCandidates,
  getEssentia,
  type TrackInput,
} from './lib/candidates.js';
import { bpmAccuracies, keyScore, median, type KeyRelation } from './lib/metrics.js';
import { pcOf, PC_NAMES, type KeyTruth } from './lib/notes.js';
import { readWavS16Mono } from './lib/wav.js';

type SetName = 'synthetic-bpm' | 'synthetic-key' | 'gs-bpm' | 'gs-key';

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const setName = argOf('--set') as SetName | null;
const limit = argOf('--limit') ? Number.parseInt(argOf('--limit') ?? '', 10) : Infinity;
if (!setName || !['synthetic-bpm', 'synthetic-key', 'gs-bpm', 'gs-key'].includes(setName)) {
  console.error('usage: pnpm bench:run --set synthetic-bpm|synthetic-key|gs-bpm|gs-key [--limit N]');
  process.exit(2);
}

const MANIFESTS: Record<SetName, string> = {
  'synthetic-bpm': 'bench/.data/synthetic/manifest-bpm.json',
  'synthetic-key': 'bench/.data/synthetic/manifest-key.json',
  'gs-bpm': 'bench/.data/giantsteps/manifest-tempo.json',
  'gs-key': 'bench/.data/giantsteps/manifest-key.json',
};
const isBpm = setName.endsWith('bpm');

interface ManifestEntry {
  id: string;
  file: string;
  bpm?: number;
  key?: string;
  scale?: 'major' | 'minor';
}

// Deterministic shuffle so --limit N takes a representative subset.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entries = (JSON.parse(readFileSync(MANIFESTS[setName], 'utf8')) as ManifestEntry[]).slice();
{
  const rand = mulberry32(42);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = entries[i];
    const b = entries[j];
    if (a && b) {
      entries[i] = b;
      entries[j] = a;
    }
  }
}
const tracks = entries.slice(0, limit);
console.error(`set=${setName} tracks=${tracks.length}`);

const essentia = await getEssentia();
const tmp = mkdtempSync(join(tmpdir(), 'audiosonde-bench-'));

interface CandidateAgg {
  name: string;
  times: number[];
  failures: number;
  // bpm
  acc1_2: number;
  acc1_4: number;
  acc2_2: number;
  acc2_4: number;
  errPct: number[];
  // key
  scoreSum: number;
  relations: Record<KeyRelation, number>;
  n: number;
}
const makeAgg = (name: string): CandidateAgg => ({
  name,
  times: [],
  failures: 0,
  acc1_2: 0,
  acc1_4: 0,
  acc2_2: 0,
  acc2_4: 0,
  errPct: [],
  scoreSum: 0,
  relations: { exact: 0, fifth: 0, relative: 0, parallel: 0, other: 0 },
  n: 0,
});

const bpmCands = isBpm ? bpmCandidates() : [];
const keyCands = isBpm ? [] : keyCandidates();
const aggs = new Map<string, CandidateAgg>();
for (const c of [...bpmCands, ...keyCands]) aggs.set(c.name, makeAgg(c.name));

const rows: Array<Record<string, unknown>> = [];
let processed = 0;

for (const entry of tracks) {
  let wavPath = entry.file;
  if (!wavPath.endsWith('.wav')) {
    wavPath = join(tmp, 'current.wav');
    await execa('ffmpeg', ['-y', '-v', 'error', '-i', entry.file, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', wavPath], {
      timeout: 120_000,
    });
  }
  const { samples, sampleRate } = readWavS16Mono(wavPath);
  if (sampleRate !== 44100) throw new Error(`expected 44100 Hz, got ${sampleRate}: ${entry.id}`);
  const vector = essentia.arrayToVector(samples);
  const input: TrackInput = { samples, wavPath, vector };
  const row: Record<string, unknown> = { id: entry.id };

  if (isBpm) {
    const ref = entry.bpm ?? NaN;
    row.ref = ref;
    for (const cand of bpmCands) {
      const agg = aggs.get(cand.name);
      if (!agg) continue;
      const t0 = performance.now();
      try {
        const est = await cand.run(input);
        agg.times.push(performance.now() - t0);
        const acc = bpmAccuracies(est.bpm, ref);
        if (acc.acc1_2) agg.acc1_2++;
        if (acc.acc1_4) agg.acc1_4++;
        if (acc.acc2_2) agg.acc2_2++;
        if (acc.acc2_4) agg.acc2_4++;
        agg.errPct.push((Math.abs(est.bpm - ref) / ref) * 100);
        agg.n++;
        row[cand.name] = { bpm: est.bpm, confidence: est.confidence };
      } catch (err) {
        agg.failures++;
        row[cand.name] = { error: String(err) };
      }
    }
  } else {
    const ref: KeyTruth = { pc: pcOf(entry.key ?? 'C'), scale: entry.scale ?? 'major' };
    row.ref = `${entry.key ?? 'C'} ${entry.scale ?? 'major'}`;
    for (const cand of keyCands) {
      const agg = aggs.get(cand.name);
      if (!agg) continue;
      const t0 = performance.now();
      try {
        const est = await cand.run(input);
        agg.times.push(performance.now() - t0);
        const { score, relation } = keyScore(est, ref);
        agg.scoreSum += score;
        agg.relations[relation]++;
        agg.n++;
        row[cand.name] = { key: `${PC_NAMES[est.pc]} ${est.scale}`, strength: est.strength, relation };
      } catch (err) {
        agg.failures++;
        row[cand.name] = { error: String(err) };
      }
    }
  }

  vector.delete();
  rows.push(row);
  processed++;
  if (processed % 25 === 0) console.error(`…${processed}/${tracks.length}`);
}

rmSync(tmp, { recursive: true, force: true });

// --- report -------------------------------------------------------------------
const pct = (num: number, den: number) => (den === 0 ? '—' : `${((100 * num) / den).toFixed(1)}%`);
const summary: Record<string, unknown> = {};
let md = `\n## ${setName} — ${tracks.length} tracks\n\n`;
if (isBpm) {
  md += '| candidate | acc1 ±2% | acc1 ±4% | acc2 ±2% | acc2 ±4% | med err | med ms | fail |\n';
  md += '|---|---|---|---|---|---|---|---|\n';
  for (const agg of aggs.values()) {
    md += `| ${agg.name} | ${pct(agg.acc1_2, agg.n)} | ${pct(agg.acc1_4, agg.n)} | ${pct(agg.acc2_2, agg.n)} | ${pct(agg.acc2_4, agg.n)} | ${median(agg.errPct).toFixed(2)}% | ${median(agg.times).toFixed(0)} | ${agg.failures} |\n`;
    summary[agg.name] = {
      n: agg.n,
      failures: agg.failures,
      acc1_2: agg.acc1_2 / Math.max(1, agg.n),
      acc1_4: agg.acc1_4 / Math.max(1, agg.n),
      acc2_2: agg.acc2_2 / Math.max(1, agg.n),
      acc2_4: agg.acc2_4 / Math.max(1, agg.n),
      medianErrPct: median(agg.errPct),
      medianMs: median(agg.times),
    };
  }
} else {
  md += '| candidate | MIREX | exact | exact+rel | fifth | parallel | other | med ms | fail |\n';
  md += '|---|---|---|---|---|---|---|---|---|\n';
  for (const agg of aggs.values()) {
    const r = agg.relations;
    md += `| ${agg.name} | ${(agg.scoreSum / Math.max(1, agg.n)).toFixed(3)} | ${pct(r.exact, agg.n)} | ${pct(r.exact + r.relative, agg.n)} | ${pct(r.fifth, agg.n)} | ${pct(r.parallel, agg.n)} | ${pct(r.other, agg.n)} | ${median(agg.times).toFixed(0)} | ${agg.failures} |\n`;
    summary[agg.name] = {
      n: agg.n,
      failures: agg.failures,
      mirex: agg.scoreSum / Math.max(1, agg.n),
      exact: r.exact / Math.max(1, agg.n),
      exactOrRelative: (r.exact + r.relative) / Math.max(1, agg.n),
      relations: r,
      medianMs: median(agg.times),
    };
  }
}
console.log(md);

mkdirSync('bench/results', { recursive: true });
const outPath = `bench/results/${setName}.json`;
writeFileSync(
  outPath,
  JSON.stringify({ set: setName, date: new Date().toISOString(), tracks: tracks.length, summary, rows }, null, 2),
);
console.error(`results written to ${outPath}`);
