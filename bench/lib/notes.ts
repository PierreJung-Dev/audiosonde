const PC: Record<string, number> = {
  C: 0, 'B#': 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, 'E#': 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11, Cb: 11,
};

export const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function pcOf(name: string): number {
  const pc = PC[name.trim()];
  if (pc === undefined) throw new Error(`unknown note name: ${JSON.stringify(name)}`);
  return pc;
}

export interface KeyTruth {
  pc: number;
  scale: 'major' | 'minor';
}

/** Parse a GiantSteps key annotation like "D major" / "Eb minor". Returns null for anything else. */
export function parseKeyAnnotation(text: string): KeyTruth | null {
  const m = text.trim().match(/^([A-Ga-g][#b]?)\s+(major|minor)$/);
  if (!m) return null;
  const raw = m[1] ?? '';
  const note = raw.charAt(0).toUpperCase() + raw.slice(1);
  if (!(note in PC)) return null;
  return { pc: PC[note] ?? 0, scale: (m[2] ?? 'major') as 'major' | 'minor' };
}
