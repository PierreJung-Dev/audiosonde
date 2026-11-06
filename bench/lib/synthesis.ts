const TWO_PI = Math.PI * 2;

/**
 * Click track at an exact BPM: short decaying sine bursts (accented every 4th
 * beat), optionally over a quiet noise bed so detectors face a non-silent floor.
 */
export function makeClickTrack(
  bpm: number,
  seconds: number,
  sampleRate: number,
  noiseBed: boolean,
): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  if (noiseBed) {
    let lp = 0;
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 48271) % 2147483647;
      return (seed / 2147483647) * 2 - 1;
    };
    for (let i = 0; i < n; i++) {
      const w = rand();
      lp = 0.98 * lp + 0.02 * w;
      out[i] = 0.05 * (lp * 6 + 0.4 * w);
    }
  }
  const period = 60 / bpm;
  const clickLen = Math.round(0.012 * sampleRate);
  for (let b = 0; b * period < seconds; b++) {
    const start = Math.round(b * period * sampleRate);
    const accent = b % 4 === 0 ? 1 : 0.7;
    const freq = b % 4 === 0 ? 1500 : 1000;
    for (let k = 0; k < clickLen && start + k < n; k++) {
      const env = Math.exp(-k / (0.002 * sampleRate));
      out[start + k] = (out[start + k] ?? 0) + accent * 0.8 * env * Math.sin(TWO_PI * freq * (k / sampleRate));
    }
  }
  return out;
}

const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

function addNote(
  out: Float32Array,
  startS: number,
  durS: number,
  midi: number,
  gain: number,
  sampleRate: number,
): void {
  const start = Math.round(startS * sampleRate);
  const len = Math.min(Math.round(durS * sampleRate), out.length - start);
  const f0 = midiToFreq(midi);
  for (let h = 1; h <= 5; h++) {
    const f = f0 * h;
    if (f > sampleRate / 2 - 1000) break;
    const a = gain / Math.pow(h, 1.4);
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, i / (0.01 * sampleRate)) * Math.exp(-t / (durS * 0.8));
      out[start + i] = (out[start + i] ?? 0) + a * env * Math.sin(TWO_PI * f * t);
    }
  }
}

/**
 * Harmonically rich cadence establishing a key: I–IV–V–I in major,
 * i–iv–V–i in minor (harmonic-minor dominant), two passes, ~18.6 s.
 */
export function makeCadence(rootPc: number, scale: 'major' | 'minor', sampleRate: number): Float32Array {
  const chordDur = 2.2;
  const chords: Array<{ r: number; q: 'maj' | 'min' }> =
    scale === 'major'
      ? [
          { r: 0, q: 'maj' },
          { r: 5, q: 'maj' },
          { r: 7, q: 'maj' },
          { r: 0, q: 'maj' },
        ]
      : [
          { r: 0, q: 'min' },
          { r: 5, q: 'min' },
          { r: 7, q: 'maj' },
          { r: 0, q: 'min' },
        ];
  const passes = 2;
  const total = chords.length * chordDur * passes + 1;
  const out = new Float32Array(Math.round(total * sampleRate));
  const base = 48 + rootPc; // tonic around C3
  let t = 0;
  for (let p = 0; p < passes; p++) {
    for (const c of chords) {
      const root = base + c.r;
      const third = root + (c.q === 'maj' ? 4 : 3);
      const fifth = root + 7;
      addNote(out, t, chordDur, root - 12, 0.22, sampleRate);
      addNote(out, t, chordDur, root, 0.2, sampleRate);
      addNote(out, t, chordDur, third, 0.18, sampleRate);
      addNote(out, t, chordDur, fifth, 0.18, sampleRate);
      t += chordDur;
    }
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i] ?? 0));
  if (peak > 0) {
    const g = 0.9 / peak;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * g;
  }
  return out;
}
