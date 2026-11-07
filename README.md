# audiosonde

> A self-hostable, storage-agnostic **audio analysis engine**: duration & metadata, loudness
> (LUFS), streaming transcodes, multi-zoom waveform peaks, BPM & key — behind one simple,
> signed HTTP contract. Like a [radiosonde](https://en.wikipedia.org/wiki/Radiosonde), but
> for audio.

**Status: feature-complete for v1, pre-release** — milestones M0–M6 implemented (HTTP
contract & signatures, the full pipeline, all six analyzers, hardening & observability); see
[docs/implementation-plan.md](docs/implementation-plan.md).
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

| Analyzer | Output |
|---|---|
| `metadata` | duration, sample rate, channels, bit depth, bitrate, container/codec, embedded tags |
| `loudness` | integrated LUFS, true peak (dBTP), loudness range (EBU R128) |
| `transcode` | streaming derivative (MP3 or Opus), optionally LUFS-normalized |
| `peaks` | multi-zoom waveform peaks ([format guide](docs/peaks-format.md)) |
| `bpm` / `key` | tempo + musical key/scale, with calibrated confidence ([measured decision](docs/decisions/0005-bpm-key-library.md)) |
| `noop` | fetch + callback only — smoke-tests a deployment end to end |

Future (licensing must be settled first, see the policy): `sections`, `tags`.

## Quickstart

Run it, then analyze a file with nothing but `curl` and `openssl`.

### 1. Run the container

```bash
docker build -t audiosonde .
```

```bash
docker run --rm -p 8080:8080 -e AUDIOSONDE_SECRET=change-me audiosonde
```

(On Apple Silicon add `--platform linux/amd64` to both commands — the image pins an amd64
`audiowaveform` build.)

Check it's alive — reports the engine and binary versions:

```bash
curl -s localhost:8080/healthz
```

### 2. Submit a signed job

Requests are HMAC-signed: `X-Audiosonde-Signature: t=<unix-seconds>,v1=hex(hmacSHA256(secret, "<t>.<body>"))`.

One thing to know for a local trial: **the SSRF guard refuses private/loopback URLs by
design**, so `source.url` and `callback.url` must be public. Grab a callback inspection URL
(e.g. from [webhook.site](https://webhook.site)) and any public audio file URL, then:

```bash
SECRET=change-me
BODY='{"jobId":"smoke-1","source":{"url":"<PUBLIC_AUDIO_URL>"},"analyses":["metadata","loudness","bpm","key"],"callback":{"url":"<YOUR_CALLBACK_URL>"}}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
curl -i -X POST localhost:8080/v1/jobs -H "content-type: application/json" -H "x-audiosonde-signature: t=$T,v1=$SIG" -d "$BODY"
```

You get `202 {"accepted":true,…}` immediately; seconds later the signed result JSON
(measurements, timings, `algoVersions`) lands on your callback URL. Everything else —
transcode/peaks output slots, error taxonomy, callback shape, limits — is in
[docs/contract.md](docs/contract.md). **Verify the callback signature** (same scheme, same
secret) before trusting results.

### Local development (without Docker)

Node ≥ 22, pnpm, and `ffmpeg`/`ffprobe`/`audiowaveform` on PATH
(`brew install ffmpeg audiowaveform` / the BBC PPA on Ubuntu), then:

```bash
pnpm install
```

```bash
AUDIOSONDE_SECRET=change-me pnpm dev
```

`pnpm test` runs the suite (fixtures are ffmpeg-generated at bootstrap — no audio is
committed); `pnpm load:sanity` runs the concurrency/memory sanity check.

## Deploying

audiosonde is one stateless container: run it anywhere that builds a Dockerfile, give it
`AUDIOSONDE_SECRET`, point health checks at `/readyz`, and scale horizontally with more
replicas. Two recipes follow — adjust names/regions. *(Written against each platform's
current docs; not yet verified against live accounts — please report drift.)*

Sizing (measured, see [docs/architecture.md](docs/architecture.md)): **2 GB RAM for the
default `MAX_CONCURRENT_JOBS=4`, 1 GB for 1–2**. Don't enable scale-to-zero / auto-stop:
in-flight jobs are in-memory and a stopped machine drops them.

### Fly.io

`fly.toml` next to the Dockerfile:

```toml
app = "my-audiosonde"

[build]

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"   # in-memory jobs — never stop mid-job
  min_machines_running = 1

[[http_service.checks]]
  method = "GET"
  path = "/readyz"
  interval = "15s"
  timeout = "2s"

[[vm]]
  memory = "2gb"               # MAX_CONCURRENT_JOBS=4 (see sizing)
  cpus = 2
```

```bash
fly launch --no-deploy --copy-config
```

```bash
fly secrets set AUDIOSONDE_SECRET=$(openssl rand -hex 32)
```

```bash
fly deploy
```

Then run the [quickstart smoke test](#2-submit-a-signed-job) against
`https://my-audiosonde.fly.dev`.

### Railway

1. New project → **Deploy from GitHub repo** — Railway detects the Dockerfile and builds it.
2. Variables: add `AUDIOSONDE_SECRET` (e.g. `openssl rand -hex 32`).
3. Settings → Health check path: `/readyz`.
4. Settings → Networking → Generate domain; pick a plan/limits per the sizing above
   (Railway bills by usage; pin **Serverless/app sleeping off** — in-memory jobs).

### Configuration

All env vars (defaults in parentheses): `AUDIOSONDE_SECRET` (required),
`AUDIOSONDE_SECRET_PREVIOUS` (rotation), `HOST` (`0.0.0.0`), `PORT` (`8080`),
`MAX_CONCURRENT_JOBS` (`4`, backpressure via `429` beyond it), `MAX_SOURCE_BYTES` (500 MB),
`MAX_DURATION_MS` (4 h), `JOB_TIMEOUT_MS` (10 min), `ANALYZER_TIMEOUT_MS` (5 min),
`SIGNATURE_TOLERANCE_SECONDS` (`300`), `METRICS_ENABLED` (`true` — Prometheus `/metrics`),
`FFMPEG_PATH`/`FFPROBE_PATH`/`AUDIOWAVEFORM_PATH`. See [.env.example](.env.example).

## Documentation

- [docs/contract.md](docs/contract.md) — the HTTP API contract (v1): requests, callbacks, signatures, error model.
- [docs/architecture.md](docs/architecture.md) — components, security model, timeout budget, sizing, deployment.
- [docs/implementation-plan.md](docs/implementation-plan.md) — milestones M0→M6 with acceptance criteria.
- [docs/licensing-policy.md](docs/licensing-policy.md) — the rules that keep this engine commercially safe to *use*.
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities; the security model in brief.
- [CLAUDE.md](CLAUDE.md) — working agreement for AI agents contributing to this repo.

## License

[AGPL-3.0-only](LICENSE). You can run audiosonde as part of a commercial product — the AGPL
covers the *engine's* code, not yours, as long as you interact with it over its API. If you
modify the engine and let users interact with it over a network, you must publish your
modified source under the AGPL.

Issues and bug reports are welcome. **Code contributions are not open yet** — the
contribution policy (DCO vs CLA) will be settled before the first external PR is merged;
see [CONTRIBUTING.md](CONTRIBUTING.md).
