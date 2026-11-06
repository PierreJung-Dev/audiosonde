# Licensing policy

audiosonde is **AGPL-3.0-only**, and it is *used* by commercial products over its API. Both
facts constrain what we may depend on. This policy is binding for every dependency, binary,
and ML model. **Update the tables below in the same PR that adds a dependency.**

## Why this shape

- The engine being AGPL lets us embed strong copyleft libraries (Essentia is AGPL-3.0) —
  obligations are satisfied by this repo being public.
- Callers (including commercial, closed-source ones) interact over HTTP only: the AGPL does
  not cross that boundary ("mere aggregation"). Keep it that way — no shipping client SDK
  code *from this repo* into proprietary codebases without a separate permissive license.

## Rule 1 — Dependencies (code)

Allowed: MIT, BSD, ISC, Apache-2.0, MPL-2.0, LGPL, GPL-2.0+, GPL-3.0, AGPL-3.0
(AGPL-compatible licenses). Forbidden: proprietary/no-license, SSPL, BUSL, JSON license,
non-commercial or research-only terms.

## Rule 2 — ML models have THREE license layers

**Code, weights, training data — check all three.** The trap: permissive code with
**non-commercial weights**. Open-sourcing our code does **not** unlock NC weights — CC BY-NC
is a restriction on *use*, and our use is commercial.

**Banned regardless of code license** (verified 2026-07):
- MTG/Essentia pretrained models (MusiCNN, discogs-effnet, …) — weights CC BY-NC-SA 4.0.
- madmom pretrained models — weights CC BY-NC-SA 4.0 (code is BSD; the *models* are NC).

Paths for future tagging/structure analyzers: commercial license from the rights holder
(UPF/MTG sells one), weights under a genuinely permissive license (verify, then record here),
training our own, or a third-party API on the caller's side.

## Rule 3 — Codecs & patents

- **Encode**: MP3 (patents expired 2017) and Opus (royalty-free) **only**. **Never AAC**
  (Via LA patent pool) or any codec requiring royalties.
- **Decode**: whatever ffmpeg's default free build decodes is fine.
- ffmpeg builds: distro/static builds **without `--enable-nonfree`**. GPL builds are fine
  (subprocess; and this project is AGPL anyway).

## Rule 4 — Test & benchmark audio

No copyrighted audio in the repo, ever. Fixtures are ffmpeg-generated (tones, noise, clicks)
or verifiably CC0. Benchmark reference tracks (M5) are fetched at run time and never
committed: either openly licensed, or — for research annotation datasets (GiantSteps) —
downloaded from the dataset maintainers' own public distribution mirror (JKU), verified
against the dataset's per-file checksums, used solely for local evaluation, and never
redistributed or shipped in any artifact.

## Dependency table (keep current)

| Dependency | Kind | License (code) | Weights/data | Notes |
|---|---|---|---|---|
| fastify | npm | MIT | — | added (M0) |
| zod | npm | MIT | — | added (M0) |
| execa | npm | MIT | — | added (M0) |
| typescript | npm (dev) | Apache-2.0 | — | added (M0) |
| tsx | npm (dev) | MIT | — | added (M0) |
| vitest | npm (dev) | MIT | — | added (M0) |
| eslint | npm (dev) | MIT | — | added (M0) |
| @eslint/js | npm (dev) | MIT | — | added (M0) |
| typescript-eslint | npm (dev) | MIT | — | added (M0) |
| @types/node | npm (dev) | MIT | — | added (M0) |
| globals | npm (dev) | MIT | — | added (M0) |
| ffmpeg / ffprobe | binary (subprocess) | LGPL/GPL build | — | in image (M0); used M2/M3; no `--enable-nonfree` |
| audiowaveform (BBC) | binary (subprocess) | GPL-3.0 | — | in image (M0) pinned `1.10.2`; used M4 |
| essentia.js | npm/WASM | AGPL-3.0 | ⚠️ MTG model weights are NC — **code only, never the models** | added (M5): benchmark + analyzer candidate |
| aubio | binary (subprocess) | GPL-3.0 | — | M5 candidate — bench-time only (brew/apt), enters the Docker image only if selected |

## Rule 5 — Contributions & relicensing

Until a CLA is in place, external contributions lock the project to AGPL-3.0 (no future
dual-licensing without every contributor's consent). Decide DCO vs CLA **before** opening
the repo to contributions (tracked in M6).
