import { request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { SsrfBlockedError, type AddressPolicy } from './ssrf.js';
import { ENGINE_VERSION } from '../version.js';

/**
 * SSRF-guarded HTTP(S) requests, used for BOTH the source fetch (GET) and the
 * callback delivery (POST). One implementation, one policy:
 *
 * - http(s) URLs only, on every hop.
 * - The address policy is enforced inside the socket's DNS lookup, so the
 *   checked address is the dialed address (no TOCTOU/rebinding gap). IP-literal
 *   hosts are checked before the request is issued (they bypass DNS).
 * - Redirects are followed up to {@link MAX_REDIRECTS} hops, each re-guarded.
 *   GET follows 301/302/303/307/308. POST follows only 307/308 (which preserve
 *   method and body); a 301/302/303 answer to a callback POST is a failure —
 *   silently converting the callback to a GET would drop the result payload.
 */

export const MAX_REDIRECTS = 3;

/**
 * Sent on every outbound request (source GET, artifact PUT, callback POST).
 * Node's http client sends NO User-Agent by default, and several CDNs and
 * anti-bot layers answer 403 to UA-less requests (Wikimedia, for one — found
 * while verifying the README quickstart). A descriptive UA is also honest:
 * operators of fetched hosts can see what is calling them.
 */
export const USER_AGENT = `audiosonde/${ENGINE_VERSION}`;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class RedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectError';
  }
}

function makeGuardedLookup(policy: AddressPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) {
        callback(err, []);
        return;
      }
      const list = addresses as LookupAddress[];
      if (list.length === 0) {
        callback(new Error(`DNS lookup for ${hostname} returned no addresses`), []);
        return;
      }
      for (const a of list) {
        const reason = policy.check(a.address);
        if (reason !== null) {
          callback(new SsrfBlockedError(hostname, a.address, reason), []);
          return;
        }
      }
      if (options.all === true) {
        callback(null, list);
      } else {
        const first = list[0] as LookupAddress;
        // The non-`all` callback signature is (err, address, family).
        (callback as unknown as (e: Error | null, addr: string, fam: number) => void)(
          null,
          first.address,
          first.family,
        );
      }
    });
  };
}

export interface SafeRequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly policy: AddressPolicy;
  readonly headers?: Record<string, string>;
  /**
   * Request body. A factory returning a fresh Readable makes large bodies
   * streamable AND re-sendable across 307/308 redirect hops.
   */
  readonly body?: Buffer | string | (() => Readable);
  /** Aborts the request (connection + body streaming). */
  readonly signal: AbortSignal;
}

export interface SafeResponse {
  readonly statusCode: number;
  readonly headers: IncomingMessage['headers'];
  /** The response body stream. Consume or destroy it. */
  readonly stream: IncomingMessage;
  /** URL that actually answered (after redirects). */
  readonly finalUrl: string;
}

function validateUrl(raw: string, policy: AddressPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RedirectError(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RedirectError(`refusing non-http(s) URL scheme: ${url.protocol}`);
  }
  // IP-literal hosts never hit the DNS lookup guard — check them here.
  // URL brackets IPv6 hosts ([::1]) — strip for the check.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(host) !== 0) {
    const reason = policy.check(host);
    if (reason !== null) throw new SsrfBlockedError(host, host, reason);
  }
  return url;
}

function issueRequest(url: URL, options: SafeRequestOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req: ClientRequest = requestFn(
      url,
      {
        method: options.method,
        headers: { 'user-agent': USER_AGENT, ...options.headers },
        lookup: makeGuardedLookup(options.policy),
        signal: options.signal,
      },
      (res) => resolve(res),
    );
    req.on('error', (err: Error & { cause?: unknown }) => {
      // Surface a lookup-level SSRF block as the root error, however the
      // socket layer wrapped it.
      if (err instanceof SsrfBlockedError) reject(err);
      else if (err.cause instanceof SsrfBlockedError) reject(err.cause);
      else reject(err);
    });
    if (typeof options.body === 'function') {
      const body = options.body();
      body.on('error', (err) => req.destroy(err));
      body.pipe(req);
    } else {
      if (options.body !== undefined) req.write(options.body);
      req.end();
    }
  });
}

/**
 * Perform a guarded request, following redirects per the policy above.
 * Resolves with the final (non-3xx) response; the caller owns the stream.
 */
export async function safeRequest(rawUrl: string, options: SafeRequestOptions): Promise<SafeResponse> {
  let currentUrl = validateUrl(rawUrl, options.policy);

  for (let hop = 0; ; hop += 1) {
    const res = await issueRequest(currentUrl, options);
    const status = res.statusCode ?? 0;

    if (!REDIRECT_STATUSES.has(status)) {
      return { statusCode: status, headers: res.headers, stream: res, finalUrl: currentUrl.href };
    }

    // Redirect: drain and release this response before following.
    res.resume();

    if (options.method !== 'GET' && status !== 307 && status !== 308) {
      throw new RedirectError(
        `${options.method} answered ${status}; refusing to change method on redirect`,
      );
    }
    if (hop >= MAX_REDIRECTS) {
      throw new RedirectError(`too many redirects (more than ${MAX_REDIRECTS})`);
    }
    const location = res.headers.location;
    if (location === undefined || location.length === 0) {
      throw new RedirectError(`redirect (${status}) without a Location header`);
    }
    currentUrl = validateUrl(new URL(location, currentUrl).href, options.policy);
  }
}
