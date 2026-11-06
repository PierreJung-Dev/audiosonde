# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub's security advisories:
**[Security → Report a vulnerability](../../security/advisories/new)** on this repository.
Do not open a public issue for anything you believe is exploitable.

You can expect an acknowledgement within a week. There is no bug bounty.

## Supported versions

audiosonde is pre-1.0: only the latest release (and `main`) receives security fixes.

## Security model (what to test against)

The engine processes untrusted audio from caller-supplied URLs; its defenses are
documented in [docs/architecture.md](docs/architecture.md). In short:

- **Authentication**: HMAC-SHA256 on both directions (inbound jobs, outbound callbacks)
  with a ±300 s replay window and constant-time comparison. There is no unauthenticated
  job path; `/healthz`, `/readyz` and `/metrics` are intentionally unauthenticated and
  expose no job content.
- **SSRF**: every outbound connection (source GET, artifact PUT, callback POST) is
  http(s)-only and vetted against private/link-local/loopback ranges inside the DNS
  lookup that opens the socket, on every redirect hop.
- **Untrusted input**: magic-bytes detection (never extension or content-type), size caps
  enforced before and during streaming, per-stage timeouts, decoding confined to ffmpeg
  subprocesses invoked with argument arrays (never a shell).
- **No stored secrets**: the engine holds no storage credentials and no database; the only
  secret is the shared HMAC key provided by the operator.

Reports that are especially welcome: SSRF-guard bypasses (DNS tricks, redirect chains,
IPv6 edge cases), signature-verification flaws, decode-path resource exhaustion that the
caps and timeouts fail to bound, and tmp-file lifecycle issues.

## Out of scope

- Denial of service by sheer volume of *validly signed* requests (deploy-side concern:
  the engine answers `429` over capacity; put a queue in front).
- Vulnerabilities in ffmpeg/audiowaveform themselves (report upstream; we track and ship
  updated builds).
- Anything requiring a compromised caller secret — rotate it (`AUDIOSONDE_SECRET_PREVIOUS`
  supports zero-downtime rotation).
