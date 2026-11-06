/**
 * Measures candidate confidence mechanisms for the Percival BPM estimate,
 * using the per-track results of a previous `bench:run --set gs-bpm`:
 *
 *  - LoopBpmConfidence(signal, percivalBpm) — essentia's cheap confidence;
 *  - split-half agreement — Percival re-run on each half of the track,
 *    confidence = both halves agree with the full-track estimate (±2%,
 *    octave-tolerant).
 *
 * Prints calibration tables (confidence bucket → acc2 ±2% of the stored
 * Percival estimate vs the GiantSteps annotation) and writes
 * bench/results/gs-bpm-confidence.json.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { getEssentia } from './lib/candidates.js';
import { readWavS16Mono } from './lib/wav.js';

interface EssVec {
  delete(): void;
}

const results = JSON.parse(readFileSync('bench/results/gs-bpm.json', 'utf8')) as {
  rows: Array<{ id: string; ref: number; 'essentia-percival'?: { bpm?: number } }>;
};
const manifest = JSON.parse(readFileSync('bench/.data/giantsteps/manifest-tempo.json', 'utf8')) as Array<{
  id: string;
  file: string;
}>;
const fileOf = new Map(manifest.map((m) => [m.id, m.file]));

const essentia = (await getEssentia()) as unknown as {
  arrayToVector(a: Float32Array): EssVec;
  LoopBpmConfidence(signal: EssVec, bpmEstimate: number, sampleRate?: number): { confidence: number };
  PercivalBpmEstimator(signal: EssVec): { bpm: number };
};

const tmp = mkdtempSync(join(tmpdir(), 'audiosonde-conf-'));
const octaveAgree = (a: number, b: number): boolean =>
  [1, 2, 0.5, 3, 1 / 3].some((m) => Math.abs(a - b * m) <= 0.02 * b * m);

const rows: Array<{ id: string; ref: number; bpm: number; loopConf: number; halvesAgree: boolean }> = [];
let done = 0;
for (const row of results.rows) {
  const bpm = row['essentia-percival']?.bpm;
  const file = fileOf.get(row.id);
  if (!bpm || !file) continue;
  const wav = join(tmp, 'current.wav');
  await execa('ffmpeg', ['-y', '-v', 'error', '-i', file, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', wav], {
    timeout: 120_000,
  });
  const { samples } = readWavS16Mono(wav);
  const full = essentia.arrayToVector(samples);
  const loopConf = essentia.LoopBpmConfidence(full, bpm).confidence;
  full.delete();
  const mid = Math.floor(samples.length / 2);
  const h1 = essentia.arrayToVector(samples.subarray(0, mid));
  const h2 = essentia.arrayToVector(samples.subarray(mid));
  const b1 = essentia.PercivalBpmEstimator(h1).bpm;
  const b2 = essentia.PercivalBpmEstimator(h2).bpm;
  h1.delete();
  h2.delete();
  const halvesAgree = octaveAgree(b1, bpm) && octaveAgree(b2, bpm);
  rows.push({ id: row.id, ref: row.ref, bpm, loopConf, halvesAgree });
  if (++done % 50 === 0) console.error(`…${done}`);
}
rmSync(tmp, { recursive: true, force: true });

const correct = (r: { bpm: number; ref: number }) => octaveAgree(r.bpm, r.ref);
console.log(`n=${rows.length}`);
console.log('\nLoopBpmConfidence calibration (bucket → acc2 ±2%):');
for (const [lo, hi] of [
  [0, 0.25],
  [0.25, 0.5],
  [0.5, 0.75],
  [0.75, 0.9],
  [0.9, 1.01],
] as const) {
  const rs = rows.filter((r) => r.loopConf >= lo && r.loopConf < hi);
  if (!rs.length) continue;
  console.log(
    `  [${lo},${hi}) : n=${rs.length}  acc2=${((100 * rs.filter(correct).length) / rs.length).toFixed(1)}%`,
  );
}
console.log('\nSplit-half agreement calibration:');
for (const agree of [true, false]) {
  const rs = rows.filter((r) => r.halvesAgree === agree);
  if (!rs.length) continue;
  console.log(
    `  halvesAgree=${agree} : n=${rs.length}  acc2=${((100 * rs.filter(correct).length) / rs.length).toFixed(1)}%`,
  );
}
writeFileSync('bench/results/gs-bpm-confidence.json', JSON.stringify({ rows }, null, 2));
console.error('results written to bench/results/gs-bpm-confidence.json');
