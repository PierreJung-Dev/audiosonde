# M5 benchmark — BPM & key candidates

Measures the candidate libraries for the `bpm` and `key` analyzers before picking one
(see [docs/implementation-plan.md](../docs/implementation-plan.md), M5). Everything here
is reproducible from scripts; **no audio is ever committed** (`bench/.data/` and
`bench/results/` are gitignored).

## Candidates

- **BPM**: `aubio-tempo` (aubio CLI, GPL-3.0, subprocess; BPM = median inter-beat
  interval), `essentia-percival` (essentia.js WASM, AGPL-3.0), `essentia-rhythm2013`
  (essentia.js, multifeature method — the only candidate with a confidence output).
- **Key**: essentia.js `KeyExtractor` with the `temperley`, `krumhansl` and `edma`
  profiles (three candidates, one dependency). All are classic signal-processing
  algorithms — **no ML model weights involved** (the banned MTG NC-licensed models are
  a separate essentia.js feature this project never loads).

## Reference sets

- **Synthetic** (ground truth by construction, also used for CI accuracy floors):
  click tracks at exact BPMs (clean + noise bed) and I–IV–V–I / i–iv–V–i cadences in
  all 24 keys. Generated locally: `pnpm bench:synthetic`.
- **GiantSteps** (real music, electronic): open annotations from the
  [GiantSteps key](https://github.com/GiantSteps/giantsteps-key-dataset) and
  [tempo](https://github.com/GiantSteps/giantsteps-tempo-dataset) datasets (tempo uses
  the corrected `annotations_v2`). Audio (2-minute Beatport previews, ~1.8 GB) is
  fetched at bench time from the dataset maintainers' JKU mirror (Beatport CDN as
  fallback) and verified against the per-file MD5 shipped with the datasets:
  `pnpm bench:fetch`. Tracks whose audio cannot be fetched/verified are dropped from
  the manifests (coverage is printed).

## Running

```bash
pnpm bench:synthetic
pnpm bench:fetch
pnpm bench:run --set synthetic-bpm
pnpm bench:run --set synthetic-key
pnpm bench:run --set gs-bpm
pnpm bench:run --set gs-key
```

`--limit N` runs on a deterministic (seed 42) shuffled subset. Results: markdown table
on stdout + full per-track JSON in `bench/results/<set>.json`.

## Metrics

- **BPM**: acc1 = estimate within ±2% / ±4% of the annotation; acc2 = same tolerances
  but accepting octave errors ({1, 2, ½, 3, ⅓} × annotation — the classic MIREX
  Accuracy2); median absolute error; median per-track analysis time (decode excluded).
- **Key**: MIREX weighted score (exact 1.0, perfect fifth above 0.5, relative 0.3,
  parallel 0.2), plus exact and exact-or-relative rates. Fifth is counted one-directional
  (estimate a fifth above the truth), matching the common mir_eval convention.
