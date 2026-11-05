import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { JobFailure } from '../errors.js';
import { safeRequest } from '../net/request.js';
import { SsrfBlockedError, type AddressPolicy } from '../net/ssrf.js';

/**
 * Artifact upload: streamed PUT to the caller-provided signed URL, guarded by
 * the same SSRF policy as every other outbound connection. One attempt — a
 * signed PUT that answers 4xx (expired/invalid signature) will not heal, and
 * retry-of-the-job is the caller's lever (`retryable` says whether it helps).
 */

export interface UploadOptions {
  readonly contentType: string;
  readonly policy: AddressPolicy;
  readonly signal: AbortSignal;
}

export interface UploadResult {
  readonly byteSize: number;
}

export async function uploadArtifact(
  putUrl: string,
  filePath: string,
  options: UploadOptions,
): Promise<UploadResult> {
  const { size } = await stat(filePath);

  let response;
  try {
    response = await safeRequest(putUrl, {
      method: 'PUT',
      policy: options.policy,
      signal: options.signal,
      headers: {
        'content-type': options.contentType,
        'content-length': String(size),
      },
      body: () => createReadStream(filePath),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = !(err instanceof SsrfBlockedError);
    throw new JobFailure('ARTIFACT_UPLOAD_FAILED', `artifact upload failed: ${message}`, {
      retryable,
    });
  }

  response.stream.resume(); // drain
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new JobFailure(
      'ARTIFACT_UPLOAD_FAILED',
      `signed PUT answered HTTP ${response.statusCode} (expired or invalid URL?)`,
      { retryable: response.statusCode >= 500 },
    );
  }

  return { byteSize: size };
}
