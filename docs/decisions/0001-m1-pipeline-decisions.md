# 0001 — M1 pipeline decisions

**Status**: accepted (M1) · **Scope**: job runner, fetcher, callback dispatcher

## Context

M1 wires the full job path (fetch → analyze → callback) around the M0 HTTP shell. Several
small design points needed settling; none warranted its own file, so they are recorded
together.

## Decisions

1. **Backpressure rejects, never queues.** When all `MAX_CONCURRENT_JOBS` slots are busy,
   `POST /v1/jobs` answers `429` immediately. An internal queue was rejected because the
   engine is stateless by design: a queued-but-unstarted job would be lost silently on
   restart, which is strictly worse than telling the caller's queue (which owns submission
   retry) to come back later.

2. **SSRF check lives inside the socket's DNS lookup.** `src/net/request.ts` passes a
   guarded `lookup` to `http(s).request`, validating every resolved address and failing the
   connection on the first blocked one; IP-literal hosts are checked before the request.
   Checking at lookup time (rather than pre-resolving and comparing) removes the
   check-then-dial TOCTOU window a DNS rebinder could exploit. One implementation serves
   both the source GET and the callback POST.

3. **Callback POSTs follow only 307/308 redirects.** 301/302/303 historically convert POST
   to GET, which would silently drop the result payload — that is treated as a delivery
   failure (retried, then `CALLBACK_FAILED`). Source GETs follow all five statuses. Both
   cap at 3 hops, each hop re-guarded.

4. **Analyses not in this build are rejected with 422 at submission** (`analysis not
   available in this build: …`), not accepted-then-failed via callback. The engine never
   accepts work it cannot perform; the analyzer registry is the single source of truth and
   grows per milestone. A `noop` diagnostic analyzer is always available so deployments and
   integration tests can exercise the full path without audio binaries.

5. **Tests inject the address policy; production cannot.** The SSRF policy is a
   `buildServer` dependency-injection seam (loopback allowed in tests so a local mock
   caller works). There is deliberately NO env flag: a bypass that can only be expressed in
   code that constructs the server cannot ship as configuration (CLAUDE.md hard
   constraint 4 analogue for SSRF).

6. **`contentHash` accepts `sha1:` and `sha256:`** (hex), validated by schema at submission
   and verified while streaming — the file is never re-read for hashing.

## Consequences

- Callers behind QStash & co. get fast, honest `429`s and keep their retry semantics.
- A compromised DNS answer cannot steer the engine into private ranges, including on
  redirect hops.
- The contract's analysis list and a given build's abilities can differ; `/v1/jobs` tells
  the truth about the difference.
