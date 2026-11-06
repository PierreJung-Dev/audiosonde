# Implementation plan

Milestones are sequential; each is a mergeable, green state. Acceptance criteria (AC) are
binding — a milestone isn't done until they pass. Update this file (check the boxes) as you go.

## M0 — Scaffold & walking skeleton

- [x] TypeScript strict + ESM + pnpm; Fastify server with `GET /healthz` (reports engine
      version + resolved `ffmpeg`/`ffprobe`/`audiowaveform` versions).
- [x] HMAC middleware (scheme from [contract.md](contract.md)) with unit tests (valid,
      invalid, replayed, malformed).
- [x] `POST /v1/jobs`: zod validation of the full v1 request shape → `202`/`400`/`401`/`422`.
- [x] Dockerfile (Debian slim, pinned ffmpeg + audiowaveform `1.10.2`); builds via CI.
- [x] CI (GitHub Actions, GitHub-hosted runners): lint (eslint), typecheck, vitest, docker
      build — green on main since PR #1.
- Add-ons (decided during M0 kickoff):
  - [x] `GET /readyz` readiness endpoint (503 when a required binary is missing; none required
        in M0).
  - [x] Multi-secret inbound verification (`AUDIOSONDE_SECRET` + `…_PREVIOUS`) for rotation.
  - [x] Boot log of effective limits (concurrency, size/duration caps, timeouts).
  - [x] Docs: Failure & durability model + replay tradeoff (contract + architecture).
- **AC**: container boots without warnings, `/healthz` lists binary versions, signed request
  → 202 / unsigned → 401, CI green.

## M1 — Pipeline skeleton, end to end

- [x] Job runner with bounded concurrency + `429` backpressure; per-job tmp dir with
      guaranteed cleanup.
- [x] Fetcher: signed-GET download (streamed), SSRF guard (private ranges, redirect limit),
      size cap, optional `contentHash` verification, magic-bytes sniff.
- [x] Callback dispatcher: signed POST, 5 retries with backoff, `CALLBACK_FAILED` logging.
- [x] Wire a `noop` analyzer through the full path; error taxonomy implemented.
- **AC**: an integration test with a local mock caller (serves a fixture, receives the
  callback) passes: happy path, SSRF-blocked URL, hash mismatch, oversized source.

## M2 — `metadata` analyzer (ffprobe)

- [x] Duration, sample rate, channels, bit depth, bitrate, container/codec, embedded tags.
- [x] Fixture set generated with ffmpeg at test-bootstrap (sine/noise in wav/flac/mp3/ogg at
      various rates/depths) — **no committed audio binaries**.
- **AC**: golden tests across the fixture matrix; corrupt/truncated file →
  `UNSUPPORTED_FORMAT`, not a crash.

## M3 — `transcode` + `loudness` (ffmpeg)

- [x] `loudness`: integrated LUFS, true peak (dBTP), loudness range (EBU R128 via `loudnorm`
      measurement pass).
- [x] `transcode`: MP3/Opus derivative, optional two-pass `loudnorm` to `targetLufs`;
      artifact upload via signed PUT (mock server in tests).
- **AC**: normalized fixture lands within ±0.5 LU of target (re-measured); derivative decodes
  (ffprobe round-trip); expired PUT URL → `ARTIFACT_UPLOAD_FAILED`, `status: "partial"`.

## M4 — `peaks` analyzer (audiowaveform)

- [x] Multi-zoom peaks (`audiowaveform-dat` binary format + `json` option), uploaded via
      signed PUT (one artifact per zoom level — see decisions/0004); format documented
      for consumers in [peaks-format.md](peaks-format.md) (zoom levels, bit resolution).
- **AC**: golden byte-compare on fixtures; a caller can render the waveform from the `.dat`
  output (documented decode example).

## M5 — `bpm` + `key` analyzers (measured decision)

- [x] Build the reference set: GiantSteps tempo (661) + key (604) — open annotations,
      audio fetched at bench time from the maintainers' JKU mirror (md5-verified, never
      committed) — plus generated click-tracks/cadences (`pnpm bench:synthetic|fetch`).
- [x] Benchmark candidates (aubio subprocess; essentia.js Percival + RhythmExtractor2013;
      KeyExtractor temperley/krumhansl/edma) and two confidence mechanisms; accuracy,
      speed and calibration recorded in
      [decisions/0005-bpm-key-library.md](decisions/0005-bpm-key-library.md).
- [x] Implemented the winners (Percival + split-half confidence; KeyExtractor edma +
      strength) with accuracy floors from the measured baseline: BPM ±2% octave-tolerant
      95.9% on the full set (target ≥90% met) and 5/5 on the generated subset; key
      exact-or-relative 63.9% (majority met) and ≥23/24 exact on the generated subset.
- **AC**: benchmark reproducible via one script (`pnpm bench:run --set …`); accuracy
  floors asserted in CI (test/bpm-key.test.ts) and documented for the full set. ✅

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
