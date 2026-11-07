import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { JobFailure } from '../errors.js';
import { safeRequest, RedirectError } from '../net/request.js';
import { SsrfBlockedError, type AddressPolicy } from '../net/ssrf.js';
import { sniffAudio, SNIFF_BYTES, type SniffedContainer } from './sniff.js';

/**
 * Source fetcher: streams the caller's signed GET URL to a file in the job's
 * tmp dir. Enforces, in order:
 *
 *  1. SSRF policy + redirect cap (inside safeRequest)        → SOURCE_FETCH_FAILED
 *  2. size cap — Content-Length upfront AND counted bytes    → SOURCE_FETCH_FAILED
 *  3. optional contentHash verification (sha1/sha256, hex)   → HASH_MISMATCH
 *  4. magic-bytes sniff (never the extension)                → UNSUPPORTED_FORMAT
 *
 * The body is hashed while streaming — the file is never read back for step 3.
 */

export interface FetchSourceOptions {
  readonly contentHash?: string | undefined;
  readonly maxBytes: number;
  readonly policy: AddressPolicy;
  readonly signal: AbortSignal;
}

export interface FetchResult {
  readonly bytes: number;
  readonly container: SniffedContainer;
  readonly downloadMs: number;
}

const HASH_RE = /^(sha1|sha256):([0-9a-f]+)$/i;

function parseContentHash(raw: string): { algo: 'sha1' | 'sha256'; hex: string } {
  const match = HASH_RE.exec(raw);
  if (match === null) {
    throw new JobFailure(
      'HASH_MISMATCH',
      `unsupported contentHash format (expected "sha1:<hex>" or "sha256:<hex>"): ${raw}`,
      { retryable: false },
    );
  }
  return { algo: match[1]?.toLowerCase() as 'sha1' | 'sha256', hex: (match[2] as string).toLowerCase() };
}

class ByteCounter extends Transform {
  bytes = 0;
  constructor(
    private readonly maxBytes: number,
    readonly hash: ReturnType<typeof createHash> | null,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      cb(
        new JobFailure('SOURCE_FETCH_FAILED', `source exceeds the ${this.maxBytes} byte limit`, {
          retryable: false,
        }),
      );
      return;
    }
    this.hash?.update(chunk);
    cb(null, chunk);
  }
}

/** Download the source to `destPath`, enforcing every untrusted-input gate. */
export async function fetchSource(
  url: string,
  destPath: string,
  options: FetchSourceOptions,
): Promise<FetchResult> {
  const started = Date.now();
  const expected = options.contentHash !== undefined ? parseContentHash(options.contentHash) : null;

  let response;
  try {
    response = await safeRequest(url, {
      method: 'GET',
      policy: options.policy,
      signal: options.signal,
      headers: { accept: '*/*' },
    });
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    if (options.signal.aborted) {
      // The job deadline hit while connecting / waiting for headers.
      throw new JobFailure('TIMEOUT', 'source download timed out', { retryable: true });
    }
    const retryable = !(err instanceof SsrfBlockedError) && !(err instanceof RedirectError);
    const message = err instanceof Error ? err.message : String(err);
    throw new JobFailure('SOURCE_FETCH_FAILED', `source download failed: ${message}`, { retryable });
  }

  const { statusCode, headers, stream } = response;
  if (statusCode !== 200) {
    stream.resume();
    throw new JobFailure('SOURCE_FETCH_FAILED', `source URL answered HTTP ${statusCode}`, {
      retryable: statusCode >= 500,
    });
  }

  const contentLength = headers['content-length'];
  if (contentLength !== undefined && Number(contentLength) > options.maxBytes) {
    stream.destroy();
    throw new JobFailure(
      'SOURCE_FETCH_FAILED',
      `source Content-Length ${contentLength} exceeds the ${options.maxBytes} byte limit`,
      { retryable: false },
    );
  }

  const counter = new ByteCounter(options.maxBytes, expected !== null ? createHash(expected.algo) : null);
  try {
    await pipeline(stream, counter, createWriteStream(destPath), { signal: options.signal });
  } catch (err) {
    await rm(destPath, { force: true });
    if (err instanceof JobFailure) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (options.signal.aborted) {
      throw new JobFailure('TIMEOUT', 'source download timed out', { retryable: true });
    }
    throw new JobFailure('SOURCE_FETCH_FAILED', `source download failed: ${message}`, {
      retryable: true,
    });
  }

  if (expected !== null && counter.hash !== null) {
    const digest = counter.hash.digest('hex');
    if (digest !== expected.hex) {
      throw new JobFailure(
        'HASH_MISMATCH',
        `downloaded bytes hash to ${expected.algo}:${digest}, expected ${options.contentHash}`,
        { retryable: false },
      );
    }
  }

  const container = await sniffFile(destPath);
  if (container === null) {
    throw new JobFailure(
      'UNSUPPORTED_FORMAT',
      'source does not look like a supported audio file (magic bytes unrecognized)',
      { retryable: false },
    );
  }

  return { bytes: counter.bytes, container, downloadMs: Date.now() - started };
}

async function sniffFile(path: string): Promise<SniffedContainer | null> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return sniffAudio(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
