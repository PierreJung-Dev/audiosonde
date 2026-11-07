import { describe, expect, it } from 'vitest';
import { runBpmTask, runKeyTask } from '../src/media/essentia-tasks.js';

/**
 * M6: essentia.js runs in a worker thread so the engine's TIMEOUT bound is
 * enforceable (synchronous WASM on the main thread cannot be interrupted).
 * Accuracy floors live in bpm-key.test.ts; this file covers the worker
 * mechanics: round trip, deadline abort, timeout termination + respawn.
 */

const SR = 44100;

/** Decaying click train at `bpm` — plenty of signal for Percival. */
function pulseTrain(bpm: number, seconds: number): Float32Array {
  const samples = new Float32Array(SR * seconds);
  const period = Math.round((60 / bpm) * SR);
  for (let i = 0; i < samples.length; i += period) {
    for (let j = 0; j < 100 && i + j < samples.length; j += 1) {
      samples[i + j] = 1 - j / 100;
    }
  }
  return samples;
}

const OCTAVE_MULTIPLES = [1, 2, 0.5, 3, 1 / 3];
const octaveOk = (est: number, ref: number): boolean =>
  OCTAVE_MULTIPLES.some((m) => Math.abs(est - ref * m) <= 0.02 * ref * m);

const neverAborts = (): AbortSignal => new AbortController().signal;

describe('essentia worker tasks', () => {
  it('estimates tempo off the main thread without mutating the shared window', async () => {
    const samples = pulseTrain(120, 15);
    const before = samples[0];
    const res = await runBpmTask(samples, { analyzer: 'bpm', timeoutMs: 60_000, signal: neverAborts() });
    expect(octaveOk(res.full, 120), `got ${res.full}, want ~120`).toBe(true);
    expect(octaveOk(res.half1, 120)).toBe(true);
    expect(octaveOk(res.half2, 120)).toBe(true);
    // The window is shared with the other analyzer — it must not be detached.
    expect(samples.length).toBe(SR * 15);
    expect(samples[0]).toBe(before);
  }, 60_000);

  it('rejects with TIMEOUT when the job deadline already passed', async () => {
    const aborted = AbortSignal.abort();
    await expect(
      runKeyTask(pulseTrain(120, 5), { analyzer: 'key', timeoutMs: 60_000, signal: aborted }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', analyzer: 'key', retryable: true });
  });

  it('terminates a timed-out task and recovers on the next one', async () => {
    // 60 s of audio takes far longer than 1 ms to analyze — the budget timer
    // must fire, surface a structured TIMEOUT, and tear the worker down.
    await expect(
      runBpmTask(pulseTrain(120, 60), { analyzer: 'bpm', timeoutMs: 1, signal: neverAborts() }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', analyzer: 'bpm', retryable: true });

    // A respawned worker serves the next task normally.
    const res = await runKeyTask(pulseTrain(120, 5), {
      analyzer: 'key',
      timeoutMs: 60_000,
      signal: neverAborts(),
    });
    expect(res.key).toEqual(expect.any(String));
    expect(res.strength).toEqual(expect.any(Number));
  }, 60_000);
});
