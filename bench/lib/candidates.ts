import { execa } from 'execa';
import { pcOf, type KeyTruth } from './notes.js';

interface EssVector {
  delete(): void;
}

interface EssentiaInstance {
  version: string;
  arrayToVector(a: Float32Array): EssVector;
  PercivalBpmEstimator(
    signal: EssVector,
    frameSize?: number,
    frameSizeOSS?: number,
    hopSize?: number,
    hopSizeOSS?: number,
    maxBPM?: number,
    minBPM?: number,
    sampleRate?: number,
  ): { bpm: number };
  RhythmExtractor2013(
    signal: EssVector,
    maxTempo?: number,
    method?: string,
    minTempo?: number,
  ): { bpm: number; confidence: number } & Record<string, unknown>;
  KeyExtractor(
    audio: EssVector,
    averageDetuningCorrection?: boolean,
    frameSize?: number,
    hopSize?: number,
    hpcpSize?: number,
    maxFrequency?: number,
    maximumSpectralPeaks?: number,
    minFrequency?: number,
    pcpThreshold?: number,
    profileType?: string,
    sampleRate?: number,
    spectralPeaksThreshold?: number,
    tuningFrequency?: number,
    weightType?: string,
    windowType?: string,
  ): { key: string; scale: string; strength: number };
}

let essentiaSingleton: EssentiaInstance | null = null;

export async function getEssentia(): Promise<EssentiaInstance> {
  if (!essentiaSingleton) {
    const pkg = (await import('essentia.js')).default as unknown as {
      Essentia: new (wasm: unknown) => EssentiaInstance;
      EssentiaWASM: unknown;
    };
    essentiaSingleton = new pkg.Essentia(pkg.EssentiaWASM);
  }
  return essentiaSingleton;
}

/** Free every WASM-backed vector a result object carries. */
export function freeResult(res: Record<string, unknown>): void {
  for (const value of Object.values(res)) {
    if (value && typeof value === 'object' && typeof (value as EssVector).delete === 'function') {
      try {
        (value as EssVector).delete();
      } catch {
        // already freed
      }
    }
  }
}

export interface TrackInput {
  /** Decoded mono 44.1 kHz samples. */
  samples: Float32Array;
  /** Path to the decoded mono 44.1 kHz s16le wav (for subprocess candidates). */
  wavPath: string;
  /** One WASM vector per track, shared across essentia candidates. */
  vector: EssVector;
}

export interface BpmEstimate {
  bpm: number;
  confidence: number | null;
}

export interface BpmCandidate {
  name: string;
  run(input: TrackInput): Promise<BpmEstimate>;
}

export interface KeyEstimate extends KeyTruth {
  strength: number;
}

export interface KeyCandidate {
  name: string;
  run(input: TrackInput): Promise<KeyEstimate>;
}

export function bpmCandidates(): BpmCandidate[] {
  return [
    {
      name: 'aubio-tempo',
      run: async ({ wavPath }) => {
        // `aubio tempo` prints a single line: "<bpm> bpm"
        const { stdout } = await execa('aubio', ['tempo', wavPath], { timeout: 120_000 });
        const m = stdout.match(/([\d.]+)\s*bpm/);
        const bpm = m ? Number.parseFloat(m[1] ?? '') : NaN;
        if (!Number.isFinite(bpm) || bpm <= 0) throw new Error(`aubio: unparseable output ${JSON.stringify(stdout.slice(0, 80))}`);
        return { bpm, confidence: null };
      },
    },
    {
      name: 'essentia-percival',
      run: async ({ vector }) => {
        const essentia = await getEssentia();
        const res = essentia.PercivalBpmEstimator(vector);
        return { bpm: res.bpm, confidence: null };
      },
    },
    {
      name: 'essentia-rhythm2013',
      run: async ({ vector }) => {
        const essentia = await getEssentia();
        const res = essentia.RhythmExtractor2013(vector, 208, 'multifeature', 40);
        const out = { bpm: res.bpm, confidence: res.confidence };
        freeResult(res);
        return out;
      },
    },
  ];
}

const KEY_PROFILES = ['temperley', 'krumhansl', 'edma'] as const;

export function keyCandidates(): KeyCandidate[] {
  return KEY_PROFILES.map((profile) => ({
    name: `essentia-key-${profile}`,
    run: async ({ vector }) => {
      const essentia = await getEssentia();
      const res = essentia.KeyExtractor(
        vector,
        true,
        4096,
        4096,
        12,
        3500,
        60,
        25,
        0.2,
        profile,
        44100,
        0.0001,
        440,
        'cosine',
        'hann',
      );
      const scale = res.scale === 'minor' ? 'minor' : 'major';
      return { pc: pcOf(res.key), scale, strength: res.strength };
    },
  }));
}
