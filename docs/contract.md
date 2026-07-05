# API contract — v1

The contract is the product: callers integrate against this document. Breaking changes
require a new version prefix (`/v2`); additive changes are allowed within v1.

## Overview

```
POST /v1/jobs        accept an analysis job          → 202 { accepted }
GET  /healthz        liveness (no auth)              → 200 { status, version }
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

## `POST /v1/jobs`

```jsonc
{
  "jobId": "b3e0…-uuid",                    // caller-generated; echoed in the callback
  "source": {
    "url": "https://…signed-get…",           // http(s) only; fetched once, streamed to disk
    "contentHash": "sha1:9f3a…",             // optional, verified after download if present
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
      "putUrl": "https://…signed-put…",
      "format": "audiowaveform-dat",         // binary .dat (v2); "json" also supported
      "zoomLevels": [256, 1024, 4096]        // samples per pixel
    }
  },
  "callback": {
    "url": "https://api.example.com/jobs/audiosonde-callback"
  },
  "limits": { "timeoutMs": 600000 }          // optional overall cap (engine clamps to its max)
}
```

Responses: `202 {"accepted": true, "jobId": …}` · `400` (schema) · `401` (signature) ·
`422` (unsupported analysis / missing output slot). Accepting a job does not guarantee
success — failures are reported through the callback.

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
    },
    "loudness": { "integratedLufs": -9.8, "truePeakDbtp": -0.3, "loudnessRange": 6.2 },
    "transcode": { "uploaded": true, "format": "opus", "bitrateKbps": 128, "byteSize": 3812345, "normalizedToLufs": -14 },
    "peaks": { "uploaded": true, "format": "audiowaveform-dat", "zoomLevels": [256, 1024, 4096], "byteSize": 182044 },
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

## Limits (engine defaults, overridable by env)

Max source size 500 MB · max duration 4 h · overall timeout 10 min · per-analyzer timeouts ·
max concurrent jobs per instance (backpressure via `429` on `/v1/jobs`).
