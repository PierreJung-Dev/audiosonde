# API contract — v1

The contract is the product: callers integrate against this document. Breaking changes
require a new version prefix (`/v2`); additive changes are allowed within v1.

## Overview

```
POST /v1/jobs        accept an analysis job          → 202 { accepted }
GET  /healthz        liveness (no auth)              → 200 { status, version, binaries }
GET  /readyz         readiness (no auth)             → 200 ready / 503 not_ready
POST <callback.url>  audiosonde → caller, signed     (result delivery)
```

Jobs are processed asynchronously. There is no job-status polling endpoint in v1: delivery
is push-only via the callback (callers keep their own job state; QStash & friends handle
retry of the *submission*, audiosonde handles retry of the *callback*).

## Authentication & signatures

Shared-secret HMAC, both directions, one scheme:

```
X-Audiosonde-Signature: t=<unix-seconds>,v1=<hex(hmac_sha256(secret, `${t}.${rawBody}`))>
```

- Inbound (`POST /v1/jobs`): signed by the caller with the shared secret (`AUDIOSONDE_SECRET`).
  Reject if signature invalid or `|now - t| > 300s` (replay window).
- Outbound (callback): signed by audiosonde with the same secret. Callers must verify.
- Queues that forward custom headers (e.g. QStash `Upstash-Forward-X-Audiosonde-Signature`)
  can sign at enqueue time.
- **Rotation**: the engine accepts a current secret (`AUDIOSONDE_SECRET`) and an optional
  previous one (`AUDIOSONDE_SECRET_PREVIOUS`) on inbound requests; callbacks are always signed
  with the current secret. Rotate by moving the old secret to `…_PREVIOUS` and the new one to
  `AUDIOSONDE_SECRET`, then dropping `…_PREVIOUS` once all callers have migrated.
- **Replay**: the `±300s` window is the only replay protection — the engine keeps no nonce
  store (it is stateless by design). A valid request replayed within the window re-runs the
  job; idempotency is the caller's responsibility (see below).

## `POST /v1/jobs`

```jsonc
{
  "jobId": "b3e0…-uuid",                    // caller-generated; echoed in the callback
  "source": {
    "url": "https://…signed-get…",           // http(s) only; fetched once, streamed to disk
    "contentHash": "sha1:9f3a…",             // optional; "sha1:<hex>" or "sha256:<hex>", verified after download
    "filenameHint": "mix-v12.wav",           // optional, helps format detection
    "maxBytes": 524288000                    // optional caller-side cap (engine also has one)
  },
  "analyses": ["metadata", "loudness", "transcode", "peaks", "bpm", "key"],
  "outputs": {                               // required iff the matching analyzer is requested
    "transcode": {
      "putUrl": "https://…signed-put…",
      "format": "opus",                      // "mp3" | "opus" — nothing else, ever (licensing)
      "bitrateKbps": 128,
      "targetLufs": -14                      // omit to skip loudness normalization
    },
    "peaks": {
      "format": "audiowaveform-dat",         // binary .dat; "json" also supported
      "levels": [                            // ONE artifact per zoom level (a .dat/json
        { "zoom": 256,  "putUrl": "https://…signed-put…" },   // file holds exactly one
        { "zoom": 1024, "putUrl": "https://…signed-put…" },   // resolution) — max 8
        { "zoom": 4096, "putUrl": "https://…signed-put…" }    // zoom = samples per pixel
      ],
      "bits": 8                              // optional: 8 (default) | 16
    }
  },
  "callback": {
    "url": "https://api.example.com/jobs/audiosonde-callback"
  },
  "limits": { "timeoutMs": 600000 }          // optional overall cap (engine clamps to its max)
}
```

Responses: `202 {"accepted": true, "jobId": …}` · `400` (schema) · `401` (signature) ·
`422` (unsupported analysis / missing output slot) · `429` (over capacity, see below).
Accepting a job does not guarantee success — failures are reported through the callback.

- **Analysis availability**: an analysis name the contract defines but this build does not
  yet implement is rejected with `422` (`analysis not available in this build: …`) — the
  engine never accepts work it cannot perform. The available set grows release by release.
- **`noop` analysis**: a diagnostic analyzer that fetches the source and returns
  `{ "ok": true }` without analyzing anything. Use it to smoke-test a deployment
  (signatures, fetch, callback) end to end. Its result lands at `result.noop`.
- **Backpressure (`429`)**: the engine runs a bounded number of concurrent jobs and does
  not queue (it is stateless; a queued job would be silently lost on restart). When all
  slots are busy, `POST /v1/jobs` answers `429 {"error": "over_capacity", …}` with a
  `Retry-After` header — resubmission is the caller's queue's job.

## Callback payload

`POST callback.url`, signed (see above). Retried with exponential backoff (5 attempts) on
non-2xx; after that the job is dropped and logged (callers own reconciliation, e.g. a sweep
for jobs stuck in `processing`).

```jsonc
{
  "jobId": "b3e0…-uuid",
  "status": "done",                          // "done" | "failed" | "partial"
  "engine": {
    "version": "0.3.1",                      // audiosonde release
    "algoVersions": { "metadata": 1, "loudness": 1, "transcode": 1, "peaks": 1, "bpm": 2, "key": 1 }
  },
  "result": {
    "metadata": {
      "durationMs": 214032, "sampleRate": 44100, "channels": 2, "bitDepth": 24,
      "bitrateKbps": 2116, "container": "wav", "codec": "pcm_s24le",
      "tags": { "title": "…", "artist": "…" }              // embedded tags (ID3 etc.), may be {}
      // bitDepth is null for codecs without a fixed depth (mp3, vorbis, opus …);
      // container comes from magic-bytes detection (wav|flac|mp3|ogg|aiff|mp4|asf|…),
      // never from the file extension; tag keys are lowercased.
    },
    "loudness": { "integratedLufs": -9.8, "truePeakDbtp": -0.3, "loudnessRange": 6.2 },
    "transcode": { "uploaded": true, "format": "opus", "bitrateKbps": 128, "byteSize": 3812345, "normalizedToLufs": -14 },
    "peaks": { "uploaded": true, "format": "audiowaveform-dat", "zoomLevels": [256, 1024, 4096],
               "byteSize": 182044,            // total across all level artifacts
               "levels": [ { "zoom": 256, "byteSize": 120000 }, { "zoom": 1024, "byteSize": 42044 }, { "zoom": 4096, "byteSize": 20000 } ],
               "bits": 8 },                   // artifact layout: see peaks-format.md
    "bpm": { "value": 128.0, "confidence": 0.87 },
    "key": { "key": "F#", "scale": "minor", "confidence": 0.74 },
    "sections": null,                         // reserved (future analyzer): [{startMs,endMs,label,confidence}]
    "tags": null                              // reserved (future analyzer): [{label,confidence,taxonomy}]
  },
  "errors": [],                               // present when status != "done", see taxonomy
  "timings": { "totalMs": 8450, "downloadMs": 1210, "perAnalyzerMs": { "metadata": 95, "…": 0 } }
}
```

`"partial"`: some analyzers succeeded, some failed — `result` carries the successes, `errors`
the failures. Callers decide whether to retry the whole job.

## Error taxonomy

| `code` | Meaning |
|---|---|
| `SOURCE_FETCH_FAILED` | download failed / SSRF-blocked / too large |
| `HASH_MISMATCH` | downloaded bytes don't match `source.contentHash` |
| `UNSUPPORTED_FORMAT` | not a decodable audio file (magic-bytes checked, never the extension) |
| `ANALYSIS_FAILED` | an analyzer errored (scoped to `analyzer` field) |
| `ARTIFACT_UPLOAD_FAILED` | signed PUT rejected/expired |
| `TIMEOUT` | per-stage or overall timeout exceeded |
| `CALLBACK_FAILED` | (log-only, never in a callback) |

Error entries: `{ "code", "analyzer": "peaks" | null, "message", "retryable": bool }`.

## Idempotency & determinism

The engine is stateless: submitting the same `jobId` twice runs twice. Idempotency is the
**caller's** contract — key your own cache on `contentHash + algoVersions`. audiosonde
guarantees determinism: same input bytes + same `engine.algoVersions` ⇒ same measurements.
Any behavior change in an analyzer bumps its `algoVersion`.

## Health & readiness

Two unauthenticated endpoints, for orchestrators:

- `GET /healthz` — **liveness**. `200` while the process is up, with the engine version and
  the resolved binary versions: `{ "status": "ok", "version": "0.0.0", "binaries": { "ffmpeg":
  { "available": true, "version": "6.1.1" }, "ffprobe": {…}, "audiowaveform": {…} } }`.
- `GET /readyz` — **readiness**. `200 { "status": "ready", … }` when every *required* binary is
  present; `503 { "status": "not_ready", "missing": [...] }` otherwise, so a broken container is
  kept out of rotation. Which binaries are required grows as analyzers are enabled.

## Failure & durability model

audiosonde is **best-effort and in-memory** between accepting a job (`202`) and delivering its
callback. There is no persistence (by design): if the process is killed or the container
restarts while a job is in flight — downloading, analyzing, or waiting to retry a callback —
**that job is lost silently**. No callback is sent, and there is no status endpoint to query it
in v1.

Callers own durability:

- Treat `202` as "accepted for best-effort processing", not "guaranteed to complete".
- Keep your own job state and **reconcile**: sweep for jobs still `processing` past a deadline
  and resubmit. Your queue retries *submission*; audiosonde only retries the *callback* (5
  attempts, backoff).
- A callback may arrive up to 5 times (retries), or never (crash in flight). Make your callback
  handler **idempotent on `jobId`**.

## Artifact uploads (signed PUT)

Artifacts are streamed to the caller's signed PUT URLs with `Content-Length` and a fixed
`Content-Type` per artifact — sign your URLs accordingly (or leave the content type
unsigned): `transcode` mp3 → `audio/mpeg`, opus → `audio/ogg`; `peaks`
`audiowaveform-dat` → `application/octet-stream`, json → `application/json`.
A rejected/expired PUT yields `ARTIFACT_UPLOAD_FAILED` for that analyzer (job becomes
`"partial"` if others succeeded).

## Limits (engine defaults, overridable by env)

Max source size 500 MB · max duration 4 h · overall timeout 10 min · per-analyzer timeouts ·
max concurrent jobs per instance (backpressure via `429` on `/v1/jobs`).

A source whose probed duration exceeds the maximum is rejected before any decoding stage
(`loudness`, `transcode`, `peaks`, `bpm`, `key`) with `UNSUPPORTED_FORMAT`
(`"source duration … exceeds …"`, not retryable); `metadata` alone still works on it.
