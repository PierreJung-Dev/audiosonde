# 0004 — peaks output shape & pipeline

**Status**: accepted (M4) · **Scope**: `peaks` analyzer, v1 `outputs.peaks` slot

## Context

The M0 draft of the contract gave the peaks slot a SINGLE `putUrl` plus an ARRAY of
`zoomLevels`. That shape is unimplementable as written: an audiowaveform `.dat` (or json)
artifact holds exactly one resolution, and one signed PUT URL stores one object. "Multi-
zoom peaks" therefore requires one artifact — and one URL — per zoom level.

## Decisions

1. **The v1 `outputs.peaks` slot becomes `{ format, levels: [{zoom, putUrl}], bits? }`**
   (max 8 levels; `bits` 8 default or 16). The result fragment keeps `zoomLevels` and a
   total `byteSize`, adding per-level sizes.

   *Why this is an edit of /v1 and not a /v2*: the versioning rule protects integrated
   callers, and there are none — the repo is private pre-release (publication is M6) and
   nothing has ever been deployed. Cutting /v2 to fix an unimplementable draft shape in
   /v1 would permanently enshrine a broken v1 no caller ever saw. This is the only such
   edit; from first publication onward the rule applies absolutely.

2. **The source is decoded to an intermediate PCM wav (pcm_s16le) with ffmpeg before
   audiowaveform runs.** audiowaveform reads only wav/flac/ogg/opus/mp3; the intermediate
   makes every ffmpeg-decodable container (aiff, mp4, asf, …) work and pins one
   decode path. 16-bit is enough: peak data is 8-bit by default (16-bit at most).

3. **The engine emits audiowaveform's default mono mix-down** (.dat version 1; the decode
   doc covers version 2 as well). Split-channel peaks can land later as an additive
   option.

4. **Golden tests byte-compare engine output against a direct invocation of the SAME
   locally installed binary**, not against committed golden bytes. Brew (dev), the PPA
   (CI) and the Debian pin (Docker image) may run different audiowaveform versions;
   self-consistency per environment is the property worth asserting, and the documented
   decode (docs/peaks-format.md) is additionally executed against real engine output in
   CI, so the format doc cannot drift.

5. **A failed PUT for any level fails the whole `peaks` analyzer** (`ARTIFACT_UPLOAD_
   FAILED`; earlier levels may already be stored — uploads are not transactional). The
   caller retries the job; artifacts are idempotent by URL.

## Consequences

- Callers sign N PUT URLs for N zoom levels and know each artifact's size from the
  callback.
- docs/peaks-format.md is the consumer contract for rendering; CI keeps it honest.
