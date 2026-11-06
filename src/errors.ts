/**
 * Error taxonomy (see docs/contract.md). Every job failure surfaces as one of
 * these codes in the callback's `errors` array — never a silent hang.
 * `CALLBACK_FAILED` is log-only: it can, by definition, never be delivered.
 */

export const ERROR_CODES = [
  'SOURCE_FETCH_FAILED',
  'HASH_MISMATCH',
  'UNSUPPORTED_FORMAT',
  'ANALYSIS_FAILED',
  'ARTIFACT_UPLOAD_FAILED',
  'TIMEOUT',
  'CALLBACK_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Shape of one entry in the callback's `errors` array. */
export interface JobErrorEntry {
  readonly code: ErrorCode;
  /** Analyzer the error is scoped to, or null for job-level failures. */
  readonly analyzer: string | null;
  readonly message: string;
  /** Hint to the caller: might resubmitting the same job succeed? */
  readonly retryable: boolean;
}

export interface JobFailureOptions {
  analyzer?: string | null;
  retryable?: boolean;
}

/**
 * A structured job failure. Thrown by pipeline stages; the runner converts it
 * into a callback error entry. Anything else thrown is wrapped as
 * `ANALYSIS_FAILED` (analyzer scope) or `SOURCE_FETCH_FAILED` (fetch scope).
 */
export class JobFailure extends Error {
  readonly code: ErrorCode;
  readonly analyzer: string | null;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: JobFailureOptions = {}) {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
    this.analyzer = options.analyzer ?? null;
    this.retryable = options.retryable ?? false;
  }

  toEntry(): JobErrorEntry {
    return {
      code: this.code,
      analyzer: this.analyzer,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

/** Convert any thrown value into a structured error entry. */
export function toErrorEntry(
  err: unknown,
  fallbackCode: ErrorCode,
  analyzer: string | null,
): JobErrorEntry {
  if (err instanceof JobFailure) {
    // Preserve the failure's own scope unless the caller narrows it.
    return { ...err.toEntry(), analyzer: err.analyzer ?? analyzer };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: fallbackCode, analyzer, message, retryable: false };
}
