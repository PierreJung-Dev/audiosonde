# 0005 — BPM & key: the measured library decision

**Status**: accepted (M5) · **Scope**: `bpm` + `key` analyzers, `src/media/essentia.ts`, `src/media/pcm.ts`

## Context

M5 required choosing the BPM/key implementation by **measurement, not opinion**
(implementation-plan). Candidates benchmarked (bench/README.md; all reproducible via
`pnpm bench:*`):

- BPM: `aubio tempo` (CLI subprocess, GPL-3.0), essentia.js `PercivalBpmEstimator` and
  `RhythmExtractor2013` (multifeature) — essentia.js is WASM, AGPL-3.0, code only (the
  NC-licensed MTG models are never loaded; licensing-policy rules 1–2).
- Key: essentia.js `KeyExtractor` with the `temperley`, `krumhansl` and `edma` profiles.

Reference sets: **GiantSteps** tempo (n=661, `annotations_v2`) and key (n=604) — open
annotations, audio fetched at bench time from the maintainers' JKU mirror with per-file
MD5 verification (100% coverage on 2026-11-06), never committed (licensing rule 4) — plus
a generated synthetic set (click tracks + 24-key cadences) that doubles as the CI floor
fixture set.

## Measurements

GiantSteps tempo (661 tracks; acc1 = ±2% of annotation, acc2 = ±2% allowing {1,2,½,3,⅓}×):

| candidate | acc1 ±2% | acc2 ±2% | median err | median ms/track |
|---|---|---|---|---|
| **essentia-percival** | 55.7% | **95.9%** | 0.85% | 1206 |
| essentia-rhythm2013 | 58.2% | 80.9% | 1.00% | 3253 |
| aubio-tempo | 17.1% | 18.3% | 16.24% | 402 |

GiantSteps key (604 tracks; MIREX weights exact 1 / fifth 0.5 / relative 0.3 / parallel 0.2):

| candidate | MIREX | exact | exact+relative | median ms/track |
|---|---|---|---|---|
| **essentia-key-edma** | **0.650** | 57.6% | **63.9%** | 150 |
| essentia-key-krumhansl | 0.585 | 49.0% | 57.6% | 150 |
| essentia-key-temperley | 0.464 | 34.9% | 58.8% | 153 |

Synthetic set: percival & rhythm2013 100% acc2 on clicks; all three key profiles 100%
exact on the 24 cadences (floors below).

Confidence mechanisms for the Percival estimate (bench/confidence.ts, n=661):

- essentia `LoopBpmConfidence`: **useless on full tracks** — 651/661 land below 0.25
  (it is built for perfect loops). Rejected.
- **Split-half agreement** (Percival re-run on each window half, ±2% octave-tolerant
  match with the full estimate): both agree → **97.5%** correct (n=631); not both →
  **63.3%** (n=30). Selected.
- `RhythmExtractor2013`'s native confidence calibrates well (63→97% across buckets) but
  rides a worse estimator (80.9% acc2) at 3× the cost. Rejected.

## Decisions

1. **`bpm` = essentia.js PercivalBpmEstimator; `key` = essentia.js KeyExtractor (edma
   profile, strength as confidence).** One dependency, zero new binaries in the Docker
   image; aubio stays bench-only (eliminated: 18.3% acc2).
2. **No octave folding.** Folding into [90,180) lifted acc1 to 87.1% *on the EDM-centric
   GiantSteps set* but is a genre prior (it would double every 80 BPM hip-hop track).
   The engine reports the raw estimate; callers apply their own prior. Revisitable as an
   additive request option.
3. **BPM confidence = split-half agreement**, tiered 0.9 / 0.6 / 0.3 (both / one /
   neither half agreeing). 0.9 and 0.3 are measured (97.5% / 63.3%); 0.6 is interpolated.
4. **Both analyzers share one decoded window** (`ctx.pcmWindow()`): mono 44.1 kHz
   float32, ≤180 s, centered. Matches the 2-minute previews the decision was measured
   on, and bounds memory (~32 MB) for arbitrarily long sources.
5. **CI accuracy floors** (test/bpm-key.test.ts, generated fixtures, measured baseline
   100%): every click track (87, 120, 128.5, 174, 120+noise) within ±2% octave-tolerant
   with confidence 0.9; ≥23/24 cadences exactly named (one miss of headroom for future
   essentia.js/ffmpeg bumps).
6. essentia.js WASM calls are synchronous on the main thread (~1–3 s per window on an
   M-series laptop). Accepted for this worker-style engine; **M6 hardening should
   evaluate moving them to a worker_thread** if health-probe latency under load matters.

## Consequences

- The dependency table gains essentia.js (AGPL-3.0, code only); aubio is annotated
  bench-only. The Docker image is unchanged.
- `algoVersions: { bpm: 1, key: 1 }`; any estimator/profile/window change bumps them.
- The benchmark harness (bench/) stays in-repo and reproducible: rerun it before any
  essentia.js upgrade and compare against the tables above.
