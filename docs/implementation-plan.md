# Implementation plan

Milestones are sequential; each is a mergeable, green state. Acceptance criteria (AC) are
binding — a milestone isn't done until they pass. Update this file (check the boxes) as you go.

## M0 — Scaffold & walking skeleton

- [ ] TypeScript strict + ESM + pnpm; Fastify server with `GET /healthz` (reports engine
      version + resolved `ffmpeg`/`ffprobe`/`audiowaveform` versions).
- [ ] HMAC middleware (scheme from [contract.md](contract.md)) with unit tests (valid,
      invalid, replayed, malformed).
- [ ] `POST /v1/jobs`: zod validation of the full v1 request shape → `202`/`400`/`401`/`422`.
- [ ] Dockerfile (Debian slim, pinned ffmpeg + audiowaveform), builds and runs.
- [ ] CI (GitHub Actions): lint (eslint), typecheck, vitest, docker build.
- **AC**: container boots without warnings, `/healthz` lists binary versions, signed request
  → 202 / unsigned → 401, CI green.

## M1 — Pipeline skeleton, end to end

- [ ] Job runner with bounded concurrency + `429` backpressure; per-job tmp dir with
      guaranteed cleanup.
- [ ] Fetcher: signed-GET download (streamed), SSRF guard (private ranges, redirect limit),
      size cap, optional `contentHash` verification, magic-bytes sniff.
- [ ] Callback dispatcher: signed POST, 5 retries with backoff, `CALLBACK_FAILED` logging.
- [ ] Wire a `noop` analyzer through the full path; error taxonomy implemented.
- **AC**: an integration test with a local mock caller (serves a fixture, receives the
  callback) passes: happy path, SSRF-blocked URL, hash mismatch, oversized source.

## M2 — `metadata` analyzer (ffprobe)

- [ ] Duration, sample rate, channels, bit depth, bitrate, container/codec, embedded tags.
- [ ] Fixture set generated with ffmpeg at test-bootstrap (sine/noise in wav/flac/mp3/ogg at
      various rates/depths) — **no committed audio binaries**.
- **AC**: golden tests across the fixture matrix; corrupt/truncated file →
  `UNSUPPORTED_FORMAT`, not a crash.

## M3 — `transcode` + `loudness` (ffmpeg)

- [ ] `loudness`: integrated LUFS, true peak (dBTP), loudness range (EBU R128 via `loudnorm`
      measurement pass).
- [ ] `transcode`: MP3/Opus derivative, optional two-pass `loudnorm` to `targetLufs`;
      artifact upload via signed PUT (mock server in tests).
- **AC**: normalized fixture lands within ±0.5 LU of target (re-measured); derivative decodes
  (ffprobe round-trip); expired PUT URL → `ARTIFACT_UPLOAD_FAILED`, `status: "partial"`.

## M4 — `peaks` analyzer (audiowaveform)

- [ ] Multi-zoom peaks (`audiowaveform-dat` binary format + `json` option), uploaded via
      signed PUT; format documented for consumers (zoom levels, bit resolution).
- **AC**: golden byte-compare on fixtures; a caller can render the waveform from the `.dat`
  output (documented decode example).

## M5 — `bpm` + `key` analyzers (measured decision)

- [ ] Build the reference set: scripted download of openly licensed tracks with known
      BPM/key (+ generated click-tracks/chord stems). Never committed to the repo.
- [ ] Benchmark ≥2 candidates (essentia.js WASM — AGPL ok here; aubio subprocess; optional:
      keyfinder) on the reference set; record accuracy, speed, footprint in
      `docs/decisions/0001-bpm-key-library.md`.
- [ ] Implement the winner with confidence scores; set accuracy floors from the measured
      baseline (target order of magnitude: BPM within ±2% or half/double detection flagged,
      on ≥90% of the set; key exact-or-relative on the majority — finalize numbers in the
      decision doc).
- **AC**: benchmark reproducible via one script; accuracy floors asserted in CI (on the
  generated subset) and documented for the full set.

## M6 — Hardening & publication readiness

- [ ] Per-stage timeouts audited; structured logs (jobId-scoped); optional `/metrics`.
- [ ] Load sanity: N concurrent jobs on a small container without OOM (document sizing).
- [ ] Licensing table re-audited ([licensing-policy.md](licensing-policy.md)); `SECURITY.md`;
      README quickstart against a real deployment (Railway/Fly recipe).
- [ ] Publication checklist: repo history clean of secrets, contribution policy (DCO/CLA)
      decided, then flip to public.
- **AC**: a stranger can deploy from the README alone and analyze a file with `curl`.

## Explicitly out of scope (v1)

Sections/structure and genre/tags analyzers (future — model licensing must be settled first),
HLS output, stem separation, job-status polling API, synchronous mode.
