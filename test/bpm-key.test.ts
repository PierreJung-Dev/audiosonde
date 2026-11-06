import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bpmAnalyzer, type BpmResult } from '../src/analyzers/bpm.js';
import { keyAnalyzer, type KeyResult } from '../src/analyzers/key.js';
import { makeAnalyzerContext } from './helpers.js';
import { BPM_FIXTURES, FIXTURE_DIR, KEY_FIXTURES } from './fixture-gen.js';

/**
 * M5 accuracy floors, asserted in CI on the generated subset (ground truth by
 * construction). Floors derive from the measured baseline in
 * docs/decisions/0005: both analyzers scored 100% on this subset at decision
 * time; the key floor allows one miss (23/24) for cross-version headroom.
 */

const OCTAVE_MULTIPLES = [1, 2, 0.5, 3, 1 / 3];
const octaveOk = (est: number, ref: number): boolean =>
  OCTAVE_MULTIPLES.some((m) => Math.abs(est - ref * m) <= 0.02 * ref * m);

describe('bpm analyzer (M5 floors)', () => {
  it('matches every generated click track within ±2% (octave-tolerant), with calibrated confidence', async () => {
    for (const f of BPM_FIXTURES) {
      const ctx = makeAnalyzerContext(join(FIXTURE_DIR, f.file), 'wav');
      const res = (await bpmAnalyzer.run(ctx)) as BpmResult;
      expect(octaveOk(res.value, f.bpm), `${f.file}: got ${res.value}, want ~${f.bpm}`).toBe(true);
      // Clicks are maximally periodic: split halves must agree (highest tier).
      expect(res.confidence, `${f.file}: confidence`).toBe(0.9);
    }
  }, 120_000);

  it('reports the half/double pair consistently (87 vs 174 resolve to the same tempo family)', async () => {
    const run = async (file: string): Promise<number> => {
      const ctx = makeAnalyzerContext(join(FIXTURE_DIR, file), 'wav');
      return ((await bpmAnalyzer.run(ctx)) as BpmResult).value;
    };
    const low = await run('click-87.wav');
    const high = await run('click-174.wav');
    expect(octaveOk(low, 87)).toBe(true);
    expect(octaveOk(high, 174)).toBe(true);
  }, 60_000);
});

describe('key analyzer (M5 floors)', () => {
  it('names at least 23 of the 24 generated cadences exactly', async () => {
    let exact = 0;
    const misses: string[] = [];
    for (const f of KEY_FIXTURES) {
      const ctx = makeAnalyzerContext(join(FIXTURE_DIR, f.file), 'wav');
      const res = (await keyAnalyzer.run(ctx)) as KeyResult;
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
      expect(res.key).toMatch(/^[A-G]#?$/);
      if (res.key === f.key && res.scale === f.scale) exact += 1;
      else misses.push(`${f.file}: got ${res.key} ${res.scale}`);
    }
    expect(exact, misses.join('; ')).toBeGreaterThanOrEqual(23);
  }, 120_000);
});
