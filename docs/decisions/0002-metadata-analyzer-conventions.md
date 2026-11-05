# 0002 — metadata analyzer conventions

**Status**: accepted (M2) · **Scope**: `metadata` analyzer, shared ffprobe pass

## Context

ffprobe's raw output varies in shape and naming across ffmpeg versions, and some fields are
container-dependent. The contract promises deterministic measurements for the same input
bytes and algoVersions, so each reported field needs one defined source of truth.

## Decisions

1. **One ffprobe pass per job, memoized on the analyzer context** (`ctx.probe()`).
   Loudness/transcode/peaks (M3/M4) reuse it — the source is probed once, ever.
2. **`container` comes from the fetch-time magic-bytes sniff, not ffprobe.**
   `format_name` strings like `"mov,mp4,m4a,3gp,3g2,mj2"` are version-dependent and
   ambiguous; the byte-derived name (`wav`, `flac`, `mp3`, `ogg`, `aiff`, `mp4`, …) is
   stable and already computed.
3. **`bitDepth` is `bits_per_raw_sample` falling back to `bits_per_sample`, null when
   neither applies** (mp3/vorbis/opus have no fixed sample depth). Zero is treated as
   absent, matching ffprobe's "0 = unknown" convention.
4. **`bitrateKbps` prefers the format-level bitrate** (whole file, matches what callers
   expect for a music file) and falls back to the audio stream's.
5. **Tags are merged from the first audio stream then the format, keys lowercased.**
   ffprobe reports Vorbis comments on the stream and ID3 on the format; callers get one
   case-stable map either way.
6. **Probe failures are `UNSUPPORTED_FORMAT`** (non-zero ffprobe exit, or no audio
   stream), never a crash; unparseable ffprobe JSON is `ANALYSIS_FAILED`. Golden tests
   cover corrupt and truncated files.
7. **Golden tests assert byte-derived facts exactly** (rate, channels, depth, codec,
   container, tags) **and encoder-dependent ones with tolerances** (duration, bitrate), so
   brew's and Debian's ffmpeg both pass — fixtures are synthesized at test bootstrap and
   never committed.

## Consequences

- `result.metadata` is stable across the ffmpeg versions we run (dev brew, Docker Debian).
- A future ffmpeg bump that changes a *measured* value (not just formatting) still
  requires an `algoVersion` bump per the contract.
