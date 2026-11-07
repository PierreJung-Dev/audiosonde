import { Worker } from 'node:worker_threads';
import { JobFailure } from '../errors.js';

/**
 * Typed bridge to the essentia.js worker thread (essentia-worker.mjs).
 *
 * essentia.js calls are synchronous WASM: run on the main thread they block
 * the event loop for ~1–3 s per analysis window — health probes stall and,
 * worse, the per-analyzer timeout race in the runner cannot even fire while
 * the thread is blocked. In a worker_thread the main thread stays responsive
 * and a stuck computation can actually be stopped (`worker.terminate()`),
 * which makes the contract's TIMEOUT bound enforceable for bpm/key
 * (docs/decisions/0006). Results are bit-identical: same WASM build, same
 * algorithm calls, same parameters — algoVersions stay at 1.
 *
 * ONE shared worker per process: bpm/key tasks from concurrent jobs serialize
 * on it, which bounds the WASM heap to a single instance (sizing notes in
 * docs/architecture.md). On a timeout or job-deadline abort the worker is
 * terminated (the only way to stop synchronous WASM) and respawned lazily;
 * tasks queued behind the stuck one are rejected retryable.
 *
 * Licensing (docs/licensing-policy.md): essentia.js CODE is AGPL-3.0 — fine.
 * The MTG pretrained models are CC BY-NC and banned; nothing here loads them.
 */

export interface BpmTaskResult {
  /** PercivalBpmEstimator over the full window. */
  readonly full: number;
  /** Same estimator over each half (split-half confidence, decisions/0005). */
  readonly half1: number;
  readonly half2: number;
}

export interface KeyTaskResult {
  readonly key: string;
  readonly scale: string;
  readonly strength: number;
}

export interface EssentiaTaskOptions {
  /** Analyzer name for error scoping (`bpm` | `key`). */
  readonly analyzer: string;
  readonly timeoutMs: number;
  /** Job deadline; aborting terminates a running task. */
  readonly signal: AbortSignal;
}

interface WorkerReply {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

interface PendingTask {
  resolve(value: unknown): void;
  reject(err: Error): void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly analyzer: string;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingTask>();

const timeoutFailure = (analyzer: string, message: string): JobFailure =>
  new JobFailure('TIMEOUT', message, { analyzer, retryable: true });

/** Remove a task from the pending map, releasing its timer and abort hook. */
function takeTask(id: number): PendingTask | undefined {
  const task = pending.get(id);
  if (task === undefined) return undefined;
  pending.delete(id);
  clearTimeout(task.timer);
  task.signal.removeEventListener('abort', task.onAbort);
  // Idle workers must not hold the process open (tests, graceful shutdown).
  if (pending.size === 0) worker?.unref();
  return task;
}

/** Reject every pending task (worker crashed or was torn down). Retryable. */
function rejectAll(message: string): void {
  for (const id of [...pending.keys()]) {
    const task = takeTask(id);
    task?.reject(new JobFailure('ANALYSIS_FAILED', message, { analyzer: task.analyzer, retryable: true }));
  }
}

function terminateWorker(w: Worker, reason: string): void {
  if (worker === w) worker = null; // next submit respawns lazily
  rejectAll(reason);
  void w.terminate();
}

function spawnWorker(): Worker {
  const w = new Worker(new URL('./essentia-worker.mjs', import.meta.url));
  w.unref(); // submit() refs it while tasks are pending
  w.on('message', (reply: WorkerReply) => {
    const task = takeTask(reply.id);
    if (task === undefined) return; // already timed out / aborted; discard
    if (reply.ok) {
      task.resolve(reply.result);
    } else {
      task.reject(
        new JobFailure('ANALYSIS_FAILED', `essentia failed: ${reply.error ?? 'unknown error'}`, {
          analyzer: task.analyzer,
          retryable: false,
        }),
      );
    }
  });
  // Both handlers are scoped to the CURRENT worker: after a deliberate
  // terminate() the replacement may already hold pending tasks when the old
  // worker's exit event fires late — those must not be rejected.
  w.on('error', (err) => {
    if (worker !== w) return;
    worker = null;
    rejectAll(`essentia worker crashed: ${err.message}`);
  });
  w.on('exit', () => {
    if (worker !== w) return;
    worker = null;
    rejectAll('essentia worker exited unexpectedly');
  });
  return w;
}

function submit<T>(op: 'bpm' | 'key', samples: Float32Array, options: EssentiaTaskOptions): Promise<T> {
  if (options.signal.aborted) {
    return Promise.reject(
      timeoutFailure(options.analyzer, 'job deadline exceeded before the essentia task started'),
    );
  }
  const w = (worker ??= spawnWorker());
  const id = nextId;
  nextId += 1;
  // Copy before transfer: the window is SHARED between bpm and key
  // (ctx.pcmWindow memoizes it) — transferring the original buffer would
  // detach it for the other analyzer.
  const copy = samples.slice();

  return new Promise<T>((resolve, reject) => {
    const fail = (err: JobFailure): void => {
      if (takeTask(id) === undefined) return; // already settled
      reject(err);
      // A blocked synchronous WASM call can only be stopped by terminating
      // the worker. Tasks queued behind it are rejected (retryable).
      terminateWorker(w, 'essentia worker restarted after a timed-out task');
    };
    const timer = setTimeout(() => {
      fail(timeoutFailure(options.analyzer, `essentia task exceeded its ${options.timeoutMs}ms budget`));
    }, options.timeoutMs);
    const onAbort = (): void => {
      fail(timeoutFailure(options.analyzer, 'job deadline exceeded during the essentia task'));
    };
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      signal: options.signal,
      onAbort,
      analyzer: options.analyzer,
    });
    options.signal.addEventListener('abort', onAbort, { once: true });
    w.ref();
    w.postMessage({ id, op, samples: copy }, [copy.buffer]);
  });
}

/** Tempo estimates (full window + halves) for the `bpm` analyzer. */
export function runBpmTask(samples: Float32Array, options: EssentiaTaskOptions): Promise<BpmTaskResult> {
  return submit<BpmTaskResult>('bpm', samples, options);
}

/** KeyExtractor (edma) result for the `key` analyzer. */
export function runKeyTask(samples: Float32Array, options: EssentiaTaskOptions): Promise<KeyTaskResult> {
  return submit<KeyTaskResult>('key', samples, options);
}
