# CLAUDE.md

Working agreement for agents contributing to **audiosonde** — a standalone, open-source
(AGPL-3.0) audio analysis engine. Read this fully before writing code.

## What this project is

An HTTP service that accepts an analysis job (audio reachable via a signed GET URL), runs a
pipeline of **analyzers** (metadata, loudness, transcode, peaks, bpm, key — later: sections,
tags), uploads artifacts via caller-provided signed PUT URLs, and POSTs a signed JSON result
to the caller's callback URL. It powers Trackout but must stay **generic**: no Trackout
concepts in this codebase.

**Read before any non-trivial work:**
1. [docs/contract.md](docs/contract.md) — the API contract. **The contract is the product.**
2. [docs/architecture.md](docs/architecture.md) — components & security model.
3. [docs/implementation-plan.md](docs/implementation-plan.md) — milestones M0→M6 with acceptance criteria. Work milestone by milestone.
4. [docs/licensing-policy.md](docs/licensing-policy.md) — **hard constraints**, see below.

## Hard constraints (never violate)

1. **Licensing policy is law.** Before adding ANY dependency, binary, or ML model, check it
   against [docs/licensing-policy.md](docs/licensing-policy.md) and update its dependency
   table. Never add model weights under a non-commercial license (CC BY-NC-*), even
   "temporarily" — this includes the MTG/Essentia pretrained models and madmom models.
   Never encode AAC. MP3 and Opus only for derivatives.
2. **No storage credentials, ever.** The engine only uses caller-provided signed URLs. No
   S3/B2/GCS SDK, no bucket config, no credentials in env.
3. **No database.** The engine is stateless; persistence is the caller's job.
4. **Both directions signed.** Inbound jobs and outbound callbacks carry HMAC signatures
   (scheme in the contract). Unsigned/invalid requests are rejected — no "dev mode" bypass
   that could ship.
5. **SSRF guards on every fetch.** Source downloads and callbacks must refuse redirects to
   private/link-local address ranges and non-http(s) schemes.
6. **Contract changes are versioned.** Any breaking change to request/callback shapes is a
   new API version (`/v2`), not an edit of `/v1`. Additive fields are fine. Bumping an
   analyzer's behavior = bump its `algoVersion`.
7. **No copyrighted audio in the repo.** Test fixtures are generated (ffmpeg-synthesized
   tones/noise/clicks) or verifiably CC0. Reference tracks for BPM/key evaluation are
   downloaded at test time from sources listed in the plan, never committed.

## Stack (decided — don't relitigate without an entry in docs/decisions/)

- **Node 22 + TypeScript (strict)**, ESM, `pnpm`.
- **Fastify** for HTTP, **zod** for schema validation, **execa** for subprocesses.
- Heavy lifting via **subprocess binaries**: `ffmpeg`/`ffprobe` (metadata, transcode,
  loudness via two-pass `loudnorm`) and `audiowaveform` (peaks). Present in the Docker image;
  developed against locally installed binaries.
- **BPM/key library: intentionally NOT decided.** M5 selects it by measuring candidates
  (essentia.js WASM — AGPL, fine here; aubio via subprocess; others) against a reference set.
  Record the decision in `docs/decisions/`.
- **vitest** for tests, golden-file style for analyzer outputs. **Dockerfile** on
  Debian slim with pinned binary versions. CI: GitHub Actions (lint, typecheck, test, docker build).

## Conventions

- Code, comments, docs, commits: **English**.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`…).
- One analyzer = one module under `src/analyzers/`, exporting `{ name, algoVersion, run }`;
  the pipeline composes them. Keep analyzers pure-ish: filesystem in, JSON out.
- Every analyzer ships with golden tests on generated fixtures before it's considered done.
- Errors follow the taxonomy in the contract (`SOURCE_FETCH_FAILED`, `UNSUPPORTED_FORMAT`,
  `ANALYSIS_FAILED`, `ARTIFACT_UPLOAD_FAILED`, `TIMEOUT`…): a failed analyzer must produce a
  structured error in the callback, never a silent hang (per-stage timeouts).

## Definition of done (per milestone)

Milestone acceptance criteria in [docs/implementation-plan.md](docs/implementation-plan.md)
are met, tests green, lint/typecheck clean, docker image builds, docs updated (contract
examples stay truthful), licensing table updated if dependencies changed.
