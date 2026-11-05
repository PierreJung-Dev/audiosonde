# 0003 — loudness measurement, normalization & artifact uploads

**Status**: accepted (M3) · **Scope**: `loudness`, `transcode`, signed-PUT uploader

## Context

M3 adds the first ffmpeg *processing* stages and the first artifact uploads. The loudnorm
filter has sharp edges (target-dependent offsets, 192 kHz output, dynamic-mode fallback)
that needed explicit choices, verified by re-measuring normalized output.

## Decisions

1. **Normalization is two-pass `loudnorm`, linear mode, with the first pass run against
   the REAL targets.** `input_*` measurements are target-independent, but `target_offset`
   is not: feeding a defaults-measured offset into a `I=-16` second pass left the output
   0.6+ LU off target. The transcode analyzer therefore runs its own measurement with
   `I=<targetLufs>:TP=-1.5:LRA=11` and passes that `target_offset` through. The shared
   memoized measurement (defaults) still serves the `loudness` analyzer. Cost: one extra
   decode pass per normalized transcode; revisit in M6 if it matters.
2. **Fixed second-pass constants: `TP=-1.5 dBTP`, `LRA=11`** (streaming-platform
   conventions). Only `I` is caller-controlled (`targetLufs`). Changing these would change
   output audio → `algoVersion` bump.
3. **Sample rates are always pinned on encode** — loudnorm outputs 192 kHz, so mp3 gets
   `min(source, 48k)` and opus always 48 kHz (its native rate).
4. **Codec floor for the ±0.5 LU acceptance test is a transparent encode (mp3 320k).**
   128 kbps mp3 of full-spectrum pink noise measurably sheds band-edge energy (≈ -0.6 LU
   under K-weighting) — a codec property, not normalization error; CI asserts the
   normalization math, not mp3's psychoacoustics.
5. **Uploads are single-attempt, streamed, SSRF-guarded.** A 4xx on a signed PUT
   (expired/invalid signature) cannot heal by retrying from here — the caller owns URL
   issuance, so the error entry says `retryable: false` for 4xx / `true` for 5xx+network
   and the caller decides. Content types are fixed per artifact and documented in the
   contract.
6. **The advertised max-duration limit is enforced after probe, before any decoding
   analyzer** (`loudness`, `transcode`, `peaks`, `bpm`, `key`), as `UNSUPPORTED_FORMAT`
   (closest existing taxonomy code; adding a new code is a contract change we don't need).
   `metadata`/`noop` run without the gate — probing a long file is cheap and legitimate.
7. **Unmeasurable loudness (digital silence → `-inf`) maps to `null`** in the loudness
   fragment, and normalization of such a source fails with `ANALYSIS_FAILED` rather than
   applying an infinite gain.

## Consequences

- Normalized output re-measures within ±0.5 LU of `targetLufs` (CI-asserted on a
  transparent encode; verified -16.03 for a -16 target on wav, -16.05 at mp3 320k).
- Derivative loudness at low bitrates may read slightly below target on pathological
  (noise-like) material; real program material is far less affected.
- Callers signing PUT URLs must account for the documented Content-Types.
