# audiosonde

> A self-hostable, storage-agnostic **audio analysis engine**: duration & metadata, loudness
> (LUFS), streaming transcodes, multi-zoom waveform peaks, BPM & key — behind one simple,
> signed HTTP contract. Like a [radiosonde](https://en.wikipedia.org/wiki/Radiosonde), but
> for audio.

**Status: in development — milestones M0–M5 implemented** (HTTP contract & signatures, the
full pipeline, `metadata`, `loudness`, `transcode`, `peaks`, `bpm`, `key`); hardening +
publication (M6) remains — see [docs/implementation-plan.md](docs/implementation-plan.md).
Built to power [Trackout](https://trackout.app), designed to be useful to anyone.

## Design principles

- **Standalone & generic.** No database, no tenant model, no knowledge of its callers.
  One job in → one JSON result out.
- **Zero storage credentials.** The caller provides short-lived **signed GET URLs** for the
  source audio and **signed PUT URLs** for artifacts (derivatives, peaks). audiosonde never
  holds keys to anyone's bucket.
- **Async by contract.** Jobs are accepted with `202`, processed, then results are POSTed to
  the caller's callback URL. Both directions are **HMAC-signed**. Any queue that can make an
  HTTP request (QStash, Cloud Tasks, cron, curl) can drive it.
- **Deterministic & versioned.** Every analyzer declares an `algoVersion`. Same input + same
  versions → same output, enabling caching and mass reprocessing keyed on
  `contentHash + algoVersion`.
- **License-clean by policy.** AGPL-3.0 engine; dependency and ML-model rules are codified in
  [docs/licensing-policy.md](docs/licensing-policy.md) (no non-commercial model weights,
  royalty-free codecs only).

## How it works

```
caller ──POST /v1/jobs (HMAC)──▶ audiosonde (container)
                                   │  download source via signed GET
                                   │  ffprobe → metadata/duration
                                   │  ffmpeg  → MP3/Opus derivative + LUFS normalization
                                   │  audiowaveform → multi-zoom peaks
                                   │  BPM / key detection
                                   │  upload artifacts via signed PUT
                                   ▼
caller ◀──POST callback (HMAC)── result JSON (measurements + algo versions)
```

## Analyses

| Analyzer | Output | Status |
|---|---|---|
| `metadata` | duration, sample rate, channels, bit depth, bitrate, container/codec, embedded tags | ✅ implemented (M2) |
| `loudness` | integrated LUFS, true peak (dBTP), loudness range | ✅ implemented (M3) |
| `transcode` | streaming derivative (MP3 or Opus), LUFS-normalized | ✅ implemented (M3) |
| `peaks` | multi-zoom waveform peaks ([format guide](docs/peaks-format.md)) | ✅ implemented (M4) |
| `bpm` / `key` | tempo + musical key/scale, with confidence ([measured decision](docs/decisions/0005-bpm-key-library.md)) | ✅ implemented (M5) |
| `sections` | song structure (intro/verse/chorus…) | future |
| `tags` | genre & descriptor tags | future (see [licensing policy](docs/licensing-policy.md)) |

## Documentation

- [docs/contract.md](docs/contract.md) — the HTTP API contract (v1): requests, callbacks, signatures, error model.
- [docs/architecture.md](docs/architecture.md) — components, security model, deployment.
- [docs/implementation-plan.md](docs/implementation-plan.md) — milestones M0→M6 with acceptance criteria.
- [docs/licensing-policy.md](docs/licensing-policy.md) — the rules that keep this engine commercially safe to *use*.
- [CLAUDE.md](CLAUDE.md) — working agreement for AI agents contributing to this repo.

## License

[AGPL-3.0-only](LICENSE). You can run audiosonde as part of a commercial product — the AGPL
covers the *engine's* code, not yours, as long as you interact with it over its API. If you
modify the engine and let users interact with it over a network, you must publish your
modified source under the AGPL.

Contributions are not open yet (the project is in its private bootstrap phase); a
contribution policy (DCO/CLA) will be settled before opening up.
