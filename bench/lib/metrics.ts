import type { KeyTruth } from './notes.js';

export interface BpmAccuracies {
  acc1_2: boolean; // within ±2% of the reference
  acc1_4: boolean; // within ±4% (classic MIREX Accuracy1)
  acc2_2: boolean; // ±2% allowing {1, 2, 1/2, 3, 1/3} × reference
  acc2_4: boolean; // ±4% allowing the same multiples (classic Accuracy2)
}

export function bpmAccuracies(est: number, ref: number): BpmAccuracies {
  const within = (e: number, r: number, tol: number) => Math.abs(e - r) <= tol * r;
  const mults = [1, 2, 0.5, 3, 1 / 3];
  return {
    acc1_2: within(est, ref, 0.02),
    acc1_4: within(est, ref, 0.04),
    acc2_2: mults.some((m) => within(est, ref * m, 0.02)),
    acc2_4: mults.some((m) => within(est, ref * m, 0.04)),
  };
}

export type KeyRelation = 'exact' | 'fifth' | 'relative' | 'parallel' | 'other';

/**
 * MIREX-style weighted key score: exact 1.0; perfect fifth above (same mode) 0.5;
 * relative major/minor 0.3; parallel major/minor 0.2; anything else 0.
 */
export function keyScore(est: KeyTruth, ref: KeyTruth): { score: number; relation: KeyRelation } {
  if (est.pc === ref.pc && est.scale === ref.scale) return { score: 1, relation: 'exact' };
  if (est.scale === ref.scale && est.pc === (ref.pc + 7) % 12) return { score: 0.5, relation: 'fifth' };
  if (ref.scale === 'major' && est.scale === 'minor' && est.pc === (ref.pc + 9) % 12) {
    return { score: 0.3, relation: 'relative' };
  }
  if (ref.scale === 'minor' && est.scale === 'major' && est.pc === (ref.pc + 3) % 12) {
    return { score: 0.3, relation: 'relative' };
  }
  if (est.pc === ref.pc) return { score: 0.2, relation: 'parallel' };
  return { score: 0, relation: 'other' };
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? NaN) : ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2;
}
