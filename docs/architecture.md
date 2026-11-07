# Architecture

## Components

```
                 ┌──────────────────────────────────────────────────┐
 POST /v1/jobs   │  HTTP layer (Fastify)                            │
 ──────────────▶ │   - HMAC verification, zod schema, backpressure  │
                 │   - 202 + enqueue into in-process job runner     │
                 └───────────────┬──────────────────────────────────┘
                                 ▼
                 ┌──────────────────────────────────────────────────┐
                 │  Pipeline runner (per job, bounded concurrency)  │
                 │   1. fetcher      — signed GET → tmp file        │
                 │      (SSRF guard, size cap, hash check,          │
                 │       magic-bytes sniff)                         │
                 │   2. analyzers    — registry, each declares      │
                 │      { name, algoVersion, run(ctx) }             │
                 │      metadata | loudness | transcode | peaks     │
                 │      | bpm | key   (future: sections, tags)      │
                 │   3. uploader     — artifacts → signed PUT URLs  │
                 │   4. callback     — signed result POST, retries  │
                 │   5. cleanup      — tmp dir removal (always)     │
                 └──────────────────────────────────────────────────┘
```

- **Analyzers are modules** (`src/analyzers/<name>.ts`) that take a context (path to the
  downloaded file, probe data, options) and return their JSON fragment. The pipeline resolves
  ordering (e.g. `metadata` runs first, `transcode` depends on `loudness` measurement when
  normalization is requested) and enforces per-analyzer timeouts.
- **Subprocess strategy**: `ffprobe`/`ffmpeg`/`audiowaveform` are invoked via `execa` with
  argument arrays (never shell strings), explicit timeouts, and stderr capture for error
  reporting. Binary paths and versions are resolved at boot and reported in `/healthz`.
- **essentia.js (bpm/key) runs in one shared worker thread** (`src/media/essentia-tasks.ts`,
  decisions/0006): its calls are synchronous WASM, so on the main thread they would block the
  event loop AND make the analyzer timeout unenforceable. The worker is terminated and
  respawned if a task overruns its budget; tasks from concurrent jobs serialize on it, which
  bounds the WASM heap to a single instance.

## Timeout budget

Every stage is bounded and every breach surfaces as the contract's structured `TIMEOUT`
error (never a silent hang). Defaults, all overridable by env:

| Stage | Bound | On breach |
|---|---|---|
| Whole job | `JOB_TIMEOUT_MS` (10 min; a job's `limits.timeoutMs` can only lower it) — one `AbortSignal` covers fetch → analyzers → uploads | `TIMEOUT` (job-level) |
| Source fetch (connect, headers, streaming) | the job signal | `TIMEOUT` |
| Each analyzer | `min(ANALYZER_TIMEOUT_MS (5 min), time left on the job)` via a race in the runner | `TIMEOUT` scoped to the analyzer, `retryable: true` |
| Each subprocess (ffprobe / ffmpeg / audiowaveform) | execa `timeout: ANALYZER_TIMEOUT_MS` + the job signal (`cancelSignal`) | `TIMEOUT` |
| essentia task (bpm/key) | `ANALYZER_TIMEOUT_MS` per task; the worker is `terminate()`d — the only way to stop synchronous WASM | `TIMEOUT` |
| Artifact upload (signed PUT) | inside the owning analyzer's budget + the job signal | `TIMEOUT` / `ARTIFACT_UPLOAD_FAILED` |
| Callback POST | 30 s per attempt × 5 attempts, exponential backoff (worst case ≈ 2.5 min + 15 s delays) | `CALLBACK_FAILED` (log-only) |

## Security model

- **HMAC both ways** (see contract) with a replay window; constant-time comparison. Inbound
  verification accepts a current + optional previous secret (zero-downtime rotation); the
  `±300s` window is the only replay protection (no nonce store — stateless by design).
- **SSRF guards**: http(s) only; resolve DNS and reject private/link-local/loopback ranges
  (including on redirects, max 3); apply to source fetch AND callback POST. The check runs
  inside the DNS lookup used to open the socket, so the vetted address is the dialed
  address (no rebinding window). Callback POSTs follow only 307/308 redirects (method- and
  body-preserving); a 301/302/303 answer is treated as a delivery failure.
- **Zero storage credentials**: only caller-signed URLs. The engine can be pointed at any
  storage (B2, S3, GCS, MinIO) without configuration.
- **Untrusted input discipline**: magic-bytes detection (never trust extension or
  content-type headers), size caps before and during streaming, decode inside ffmpeg (kept updated in the
  image), tmp dirs per job with cleanup on all paths.
- **No secrets in results**: signed URLs are never echoed back in callbacks or logs.

## Sizing

Measured with `pnpm load:sanity` (M6): waves of concurrent **full-pipeline** jobs —
metadata + loudness + transcode (normalized Opus) + peaks (3 zoom levels) + bpm + key —
over a 3-minute, 31.8 MB stereo wav. Numbers are the engine process's peak RSS on
macOS arm64 / Node 24, measured with the test harness (mock caller + source buffer) in the
same process, so they are conservative upper bounds; every job completed `done`, no OOM.

| `MAX_CONCURRENT_JOBS` | peak node RSS | container recommendation |
|---|---|---|
| 1 | ~430 MB | 1 GB |
| 2 | ~540 MB | 1 GB |
| 4 (default) | ~710 MB | 2 GB |

- **Add the subprocesses**: each running job drives at most one
  ffmpeg/ffprobe/audiowaveform at a time (typically 50–150 MB each) — they count against
  the container's memory limit even though they are outside the node RSS above.
- What the memory goes to: the single shared essentia WASM heap (one per process by
  design — jobs serialize on the worker), each job's decoded analysis window (≤32 MB)
  plus its transfer copy, and V8 headroom.
- **CPU**: jobs are ffmpeg-bound; cores shorten wall-clock roughly linearly up to the
  concurrency limit. On 1 shared vCPU keep `MAX_CONCURRENT_JOBS` at 1–2 — per-analyzer
  timeouts are wall-clock and heavy oversubscription will trip them.
- Over capacity the engine answers `429` and queues nothing — submission retry belongs to
  the caller's queue, so a small instance degrades gracefully under burst.

## Deployment & operations

- **One stateless container** (Debian slim, pinned ffmpeg/audiowaveform). Horizontal scaling
  = more replicas; backpressure via bounded concurrency + `429`.
- **Queue-agnostic**: any HTTP producer works. Trackout uses QStash with header forwarding;
  retries of *submission* are the queue's job, retries of *callback* are ours.
- **Observability**: structured JSON logs — every pipeline line of a job is bound to its
  `jobId` (started, fetched, analyzer failures, finished, callback outcome) via a pino child
  logger; `/healthz` (liveness + binary versions) and `/readyz` (readiness, 503 when a
  required binary is missing); timings in every callback; Prometheus `/metrics` (on by
  default, `METRICS_ENABLED=false` to disable — aggregate counters only, see contract).
- **Graceful shutdown**: SIGTERM/SIGINT stop the listener and drain in-flight jobs
  (callback delivery + tmp cleanup included) before exit. Platform grace periods are
  typically shorter than a worst-case job — whatever is still running at SIGKILL is lost,
  per the durability model.
- **Durability is best-effort**: processing is in-memory between `202` and callback; a crash or
  restart drops in-flight jobs silently (no persistence by design). Callers own reconciliation
  and must make their callback handler idempotent on `jobId` (see contract: Failure & durability
  model).
- **Config via env**: `AUDIOSONDE_SECRET`, `PORT`, `MAX_CONCURRENT_JOBS`, `MAX_SOURCE_BYTES`,
  `MAX_DURATION_MS`, `JOB_TIMEOUT_MS`, binary path overrides. Fail-closed: refuse to boot
  without a secret.

## Non-goals

- No persistence/DB, no job-status API (push-only in v1), no multi-tenancy, no storage SDKs,
  no synchronous analysis mode, no UI. Callers own orchestration and state.
