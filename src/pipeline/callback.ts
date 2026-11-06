import { setTimeout as sleep } from 'node:timers/promises';
import { signPayload } from '../hmac.js';
import { safeRequest } from '../net/request.js';
import { SsrfBlockedError, type AddressPolicy } from '../net/ssrf.js';

/**
 * Callback dispatcher: POSTs the signed result to the caller's callback URL.
 *
 * - Signed with the CURRENT secret (rotation: callers verify against both).
 * - 5 attempts with exponential backoff (base × 2^attempt). Non-2xx and
 *   network errors retry; an SSRF-blocked URL does not (it can never succeed).
 * - On exhaustion the caller of this function logs `CALLBACK_FAILED` — that
 *   code is log-only by definition (there is nowhere left to deliver it).
 */

export const CALLBACK_ATTEMPTS = 5;
const ATTEMPT_TIMEOUT_MS = 30_000;

export interface DispatchOptions {
  readonly secret: string;
  readonly policy: AddressPolicy;
  readonly attempts?: number;
  readonly baseDelayMs?: number;
}

export interface DispatchOutcome {
  readonly delivered: boolean;
  readonly attempts: number;
  /** Last HTTP status seen, if any response arrived. */
  readonly lastStatus?: number;
  readonly lastError?: string;
}

export async function dispatchCallback(
  url: string,
  payload: unknown,
  options: DispatchOptions,
): Promise<DispatchOutcome> {
  const rawBody = JSON.stringify(payload);
  const attempts = options.attempts ?? CALLBACK_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await safeRequest(url, {
        method: 'POST',
        policy: options.policy,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(rawBody)),
          // Re-signed per attempt so the timestamp stays inside the caller's
          // replay window even after backoff delays.
          'x-audiosonde-signature': signPayload(options.secret, rawBody),
        },
        body: rawBody,
      });
      response.stream.resume(); // drain; the body is irrelevant
      lastStatus = response.statusCode;
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { delivered: true, attempts: attempt, lastStatus };
      }
      lastError = `callback answered HTTP ${response.statusCode}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof SsrfBlockedError) {
        // Policy violations don't heal with retries.
        return { delivered: false, attempts: attempt, lastError };
      }
    }
    if (attempt < attempts) {
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  return {
    delivered: false,
    attempts,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}
