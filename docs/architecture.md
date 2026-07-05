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

## Security model

- **HMAC both ways** (see contract) with a replay window; constant-time comparison.
- **SSRF guards**: http(s) only; resolve DNS and reject private/link-local/loopback ranges
  (including on redirects, max 3); apply to source fetch AND callback POST.
- **Zero storage credentials**: only caller-signed URLs. The engine can be pointed at any
  storage (B2, S3, GCS, MinIO) without configuration.
- **Untrusted input discipline**: magic-bytes detection (never trust extension or
  content-type headers), size caps before and during streaming, decode inside ffmpeg (kept updated in the
  image), tmp dirs per job with cleanup on all paths.
- **No secrets in results**: signed URLs are never echoed back in callbacks or logs.

## Deployment & operations

- **One stateless container** (Debian slim, pinned ffmpeg/audiowaveform). Horizontal scaling
  = more replicas; backpressure via bounded concurrency + `429`.
- **Queue-agnostic**: any HTTP producer works. Trackout uses QStash with header forwarding;
  retries of *submission* are the queue's job, retries of *callback* are ours.
- **Observability**: structured JSON logs (jobId-scoped), `/healthz` with binary versions,
  timings in every callback; optional Prometheus `/metrics` (M6).
- **Config via env**: `AUDIOSONDE_SECRET`, `PORT`, `MAX_CONCURRENT_JOBS`, `MAX_SOURCE_BYTES`,
  `MAX_DURATION_MS`, `JOB_TIMEOUT_MS`, binary path overrides. Fail-closed: refuse to boot
  without a secret.

## Non-goals

- No persistence/DB, no job-status API (push-only in v1), no multi-tenancy, no storage SDKs,
  no synchronous analysis mode, no UI. Callers own orchestration and state.
