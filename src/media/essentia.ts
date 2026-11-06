/**
 * Minimal, typed loader for the essentia.js WASM core — the measured M5
 * winner for both bpm and key (docs/decisions/0005).
 *
 * Licensing (docs/licensing-policy.md): essentia.js CODE is AGPL-3.0, same
 * family as this engine — fine. The MTG *pretrained models* are CC BY-NC and
 * banned; nothing here loads them (classic signal-processing algorithms only).
 *
 * Note: essentia.js calls are synchronous WASM on the main thread (~1–3 s for
 * a full analysis window). Acceptable for this worker-style engine; if health
 * probe latency ever matters, move them to a worker_thread (M6 hardening).
 */

interface EssentiaVector {
  delete(): void;
}

export interface EssentiaCore {
  version: string;
  arrayToVector(samples: Float32Array): EssentiaVector;
  PercivalBpmEstimator(
    signal: EssentiaVector,
    frameSize?: number,
    frameSizeOSS?: number,
    hopSize?: number,
    hopSizeOSS?: number,
    maxBPM?: number,
    minBPM?: number,
    sampleRate?: number,
  ): { bpm: number };
  KeyExtractor(
    audio: EssentiaVector,
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

let corePromise: Promise<EssentiaCore> | null = null;

/** Lazily instantiate the WASM core once per process. */
export function getEssentia(): Promise<EssentiaCore> {
  return (corePromise ??= (async () => {
    const pkg = (await import('essentia.js')).default as {
      Essentia: new (wasm: unknown) => unknown;
      EssentiaWASM: unknown;
    };
    return new pkg.Essentia(pkg.EssentiaWASM) as EssentiaCore;
  })());
}

/**
 * Run `fn` over a WASM vector of `samples`, always freeing the vector —
 * leaked vectors grow the WASM heap by the window size on every job.
 */
export function withVector<T>(essentia: EssentiaCore, samples: Float32Array, fn: (vec: EssentiaVector) => T): T {
  const vec = essentia.arrayToVector(samples);
  try {
    return fn(vec);
  } finally {
    vec.delete();
  }
}
