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

- [x] Per-stage timeouts audited — budget table in [architecture.md](architecture.md);
      essentia.js moved to a worker thread so bpm/key timeouts are actually enforceable
      ([decisions/0006](decisions/0006-m6-hardening.md); algoVersions unchanged, CI floors
      pass). Structured logs jobId-scoped (pino child logger); Prometheus `/metrics`
      (`METRICS_ENABLED`, default on). Graceful SIGTERM/SIGINT drain.
- [x] Load sanity: `pnpm load:sanity` — waves of concurrent full-pipeline jobs (3-min
      source), all `done`, no OOM; measured sizing documented in architecture.md and the
      README (2 GB ↔ 4 concurrent jobs).
- [x] Licensing table re-audited 2026-11-06 (M6 added no dependencies); `SECURITY.md`
      (GitHub private advisories); README quickstart + Fly/Railway recipes — recipes
      written against current platform docs, **flagged in the README as not yet verified
      against live platform accounts**; the docker-run quickstart is verified locally.
- [x] Publication checklist: repo history scanned clean of secrets (gitleaks + pattern
      scan over all refs, 2026-11-06 — only `.env.example` placeholders ever committed);
      contribution policy **deferred by owner decision (2026-11-07)** — the repo goes
      public with code contributions closed ([CONTRIBUTING.md](../CONTRIBUTING.md)), and
      DCO-vs-CLA must be settled before the first external PR is merged. Ready to flip
      public (owner action).
- **AC**: a stranger can deploy from the README alone and analyze a file with `curl`.

## Explicitly out of scope (v1)

Sections/structure and genre/tags analyzers (future — model licensing must be settled first),
HLS output, stem separation, job-status polling API, synchronous mode.
