/**
 * Generates the synthetic reference set (ground truth by construction):
 *  - click tracks at exact BPMs (clean + over a noise bed), 30 s each;
 *  - harmonically rich cadences in all 24 keys, ~18 s each.
 * Output: bench/.data/synthetic/{bpm,key}/*.wav + manifest JSONs. Never committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCadence, makeClickTrack } from './lib/synthesis.js';
import { PC_NAMES } from './lib/notes.js';
import { writeWavS16 } from './lib/wav.js';

const SR = 44100;
const ROOT = 'bench/.data/synthetic';

const BPMS = [60, 72, 87, 95, 100, 112.5, 120, 128, 140, 150, 163, 174];

const bpmDir = join(ROOT, 'bpm');
const keyDir = join(ROOT, 'key');
mkdirSync(bpmDir, { recursive: true });
mkdirSync(keyDir, { recursive: true });

const bpmManifest: Array<{ id: string; file: string; bpm: number }> = [];
for (const bpm of BPMS) {
  for (const noise of [false, true]) {
    const id = `click-${bpm}${noise ? '-noise' : ''}`;
    const file = join(bpmDir, `${id}.wav`);
    writeWavS16(file, makeClickTrack(bpm, 30, SR, noise), SR);
    bpmManifest.push({ id, file, bpm });
  }
}
writeFileSync(join(ROOT, 'manifest-bpm.json'), JSON.stringify(bpmManifest, null, 2));
console.log(`synthetic bpm set: ${bpmManifest.length} tracks`);

const keyManifest: Array<{ id: string; file: string; key: string; scale: 'major' | 'minor' }> = [];
for (let pc = 0; pc < 12; pc++) {
  for (const scale of ['major', 'minor'] as const) {
    const name = PC_NAMES[pc] ?? 'C';
    const id = `cadence-${name.replace('#', 's')}-${scale}`;
    const file = join(keyDir, `${id}.wav`);
    writeWavS16(file, makeCadence(pc, scale, SR), SR);
    keyManifest.push({ id, file, key: name, scale });
  }
}
writeFileSync(join(ROOT, 'manifest-key.json'), JSON.stringify(keyManifest, null, 2));
console.log(`synthetic key set: ${keyManifest.length} tracks`);
