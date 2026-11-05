import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC signature scheme (see docs/contract.md). Both directions use one scheme:
 *
 *   X-Audiosonde-Signature: t=<unix-seconds>,v1=<hex(hmac_sha256(secret, `${t}.${rawBody}`))>
 *
 * A request is accepted only if the signature matches an accepted secret AND
 * the timestamp is within the replay tolerance window.
 */

export const SIGNATURE_HEADER = 'x-audiosonde-signature';

const DEFAULT_TOLERANCE_SECONDS = 300;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Compute the raw hex signature for a timestamp + body under one secret. */
export function computeSignature(secret: string, t: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
}

/** Build a full `X-Audiosonde-Signature` header value. */
export function signPayload(secret: string, rawBody: string, t: number = nowSeconds()): string {
  return `t=${t},v1=${computeSignature(secret, t, rawBody)}`;
}

export type VerifyFailureReason = 'missing' | 'malformed' | 'invalid' | 'expired';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Override "now" (unix seconds); for deterministic tests. */
  now?: number;
}

function parseHeader(header: string): { t: number; v1: string } | null {
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') t = Number(value);
    else if (key === 'v1') v1 = value;
  }
  if (t === undefined || !Number.isFinite(t) || v1 === undefined || v1.length === 0) {
    return null;
  }
  return { t, v1 };
}

/**
 * Verify an inbound signature against one or more accepted secrets.
 *
 * Checks signature validity first, then the replay window, so a tampered
 * request reports `invalid` and a genuine-but-stale one reports `expired`.
 */
export function verifySignature(
  secrets: string | readonly string[],
  rawBody: string,
  header: string | undefined,
  options: VerifyOptions = {},
): VerifyResult {
  if (header === undefined || header.length === 0) return { ok: false, reason: 'missing' };

  const parsed = parseHeader(header);
  if (parsed === null) return { ok: false, reason: 'malformed' };

  const provided = Buffer.from(parsed.v1, 'hex');
  // Invalid hex (odd length / non-hex) yields a short/empty buffer.
  if (provided.length === 0) return { ok: false, reason: 'invalid' };

  const secretList = typeof secrets === 'string' ? [secrets] : secrets;
  let matched = false;
  for (const secret of secretList) {
    const expected = Buffer.from(computeSignature(secret, parsed.t, rawBody), 'hex');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      matched = true;
      break;
    }
  }
  if (!matched) return { ok: false, reason: 'invalid' };

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? nowSeconds();
  if (Math.abs(now - parsed.t) > tolerance) return { ok: false, reason: 'expired' };

  return { ok: true };
}
