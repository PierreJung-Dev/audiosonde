// Worker-thread entry for essentia.js (spawned by essentia-tasks.ts).
//
// Plain JavaScript on purpose: the worker file must be loadable by Node as-is
// in every runtime layout (vitest, tsx dev, compiled dist — the build step
// copies it next to the compiled bridge), without a TypeScript loader inside
// the worker. It is kept minimal and mirrors the shapes typed in
// essentia-tasks.ts; all validation and error mapping live on the bridge side.
//
// Licensing (docs/licensing-policy.md): essentia.js CODE is AGPL-3.0, same
// family as this engine — fine. The MTG *pretrained models* are CC BY-NC and
// banned; nothing here loads them (classic signal-processing algorithms only).
//
// The algorithm calls and parameters are EXACTLY the measured M5 winners
// (docs/decisions/0005) — any change here is an algoVersion bump.

import { parentPort } from 'node:worker_threads';
import essentiaPkg from 'essentia.js';

const { Essentia, EssentiaWASM } = essentiaPkg;
const essentia = new Essentia(EssentiaWASM);

/** Run `fn` over a WASM vector, always freeing it (leaks grow the heap). */
function withVector(samples, fn) {
  const vec = essentia.arrayToVector(samples);
  try {
    return fn(vec);
  } finally {
    vec.delete();
  }
}

/** PercivalBpmEstimator on the full window and each half (split-half confidence). */
function bpmTask(samples) {
  const full = withVector(samples, (vec) => essentia.PercivalBpmEstimator(vec).bpm);
  const mid = Math.floor(samples.length / 2);
  const half1 = withVector(samples.subarray(0, mid), (vec) => essentia.PercivalBpmEstimator(vec).bpm);
  const half2 = withVector(samples.subarray(mid), (vec) => essentia.PercivalBpmEstimator(vec).bpm);
  return { full, half1, half2 };
}

/** KeyExtractor, edma profile — parameters fixed by docs/decisions/0005. */
function keyTask(samples) {
  const res = withVector(samples, (vec) =>
    essentia.KeyExtractor(vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'edma', 44100, 0.0001, 440, 'cosine', 'hann'),
  );
  return { key: res.key, scale: res.scale, strength: res.strength };
}

parentPort.on('message', ({ id, op, samples }) => {
  try {
    const result = op === 'bpm' ? bpmTask(samples) : keyTask(samples);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
