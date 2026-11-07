# 0006 — M6 hardening: essentia worker thread, metrics, shutdown

**Status**: accepted (M6) · **Scope**: `src/media/essentia-tasks.ts`, `src/media/essentia-worker.mjs`,
`src/metrics.ts`, `src/index.ts`, timeout handling across the pipeline

## Context

Decision 6 of [0005](0005-bpm-key-library.md) deferred a question to M6: essentia.js calls
are synchronous WASM (~1–3 s per 180 s analysis window) and ran on the main thread. The M6
timeout audit found this is worse than a latency concern — **the per-analyzer timeout race
in the runner cannot fire while the event loop is blocked**, so a pathological input that
makes the estimator spin could hang the engine with no structured `TIMEOUT` ever produced
(subprocess stages don't have this problem: execa enforces their budgets out-of-process).

## Decisions

1. **essentia.js moves to a single shared `worker_thread`** (`essentia-worker.mjs`,
   spawned lazily, typed bridge in `essentia-tasks.ts`).
   - *Why one worker, not per-job*: bpm/key tasks serialize on it, which bounds the WASM
     heap to one instance regardless of job concurrency (OOM safety on small containers);
     jobs spend most of their time in ffmpeg subprocesses, so the serialization cost is
     small relative to job duration.
   - *Timeouts become enforceable*: a blocked synchronous WASM call can only be stopped by
     `worker.terminate()`; on a task timeout or job-deadline abort the worker is terminated
     and respawned, tasks queued behind it are rejected retryable, and the job gets the
     contract's structured `TIMEOUT`/`ANALYSIS_FAILED` error.
   - *The worker entry is plain JavaScript* (`.mjs`, copied to `dist/` at build) so every
     runtime layout (vitest, tsx dev, compiled dist) loads it without a TS loader inside
     the worker; the algorithm calls and parameters are byte-for-byte the ones from 0005.
   - **`algoVersions` stay at `bpm: 1`, `key: 1`**: same WASM build, same calls, same
     parameters, same results — only the thread changed. CI accuracy floors
     (test/bpm-key.test.ts) pass unchanged, which is the regression gate 0005 defined.
2. **`GET /metrics` (Prometheus text format) is hand-rolled** (`src/metrics.ts`): a dozen
   fixed series (jobs in flight / accepted / rejected / completed by status, errors by
   taxonomy code, callback outcomes, job duration sum/count) over closed label sets.
   A prom-client dependency wasn't warranted for that. Off switch: `METRICS_ENABLED=false`.
3. **Logs are jobId-scoped** via a pino child logger per job (started / fetched / analyzer
   failed / finished / callback outcome) — `RunnerLogger` gained `child()`.
4. **Graceful shutdown**: SIGTERM/SIGINT stop the listener and drain in-flight jobs
   (callbacks + tmp cleanup) before exit. Jobs still running when the platform's grace
   period ends are lost, as the durability model documents.
5. **Timeout audit fixes**: an abort during connection setup now maps to `TIMEOUT` (was
   `SOURCE_FETCH_FAILED`), and all five subprocess sites treat execa's `isCanceled`
   (job-deadline abort) as `TIMEOUT`, not a generic failure. The full stage-by-stage
   budget table lives in [architecture.md](../architecture.md).

## Consequences

- No new dependencies; the licensing table is unchanged (worker_threads is Node built-in).
- `pnpm build` is now `tsc` + a copy of the worker entry into `dist/media/`.
- Sizing guidance (measured via `pnpm load:sanity`) is documented in architecture.md.
