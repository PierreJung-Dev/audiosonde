import { z } from 'zod';

/**
 * v1 request schema for `POST /v1/jobs`.
 *
 * Validation is two-staged so we can return the contract's distinct codes:
 *   - structural problems (wrong types, missing required fields) → 400
 *   - semantic problems (unknown analysis, missing output slot)  → 422
 *
 * Unknown keys are stripped (zod default), not rejected: the contract allows
 * additive fields within v1, so older/newer callers interoperate.
 */

export const KNOWN_ANALYSES = [
  'metadata',
  'loudness',
  'transcode',
  'peaks',
  'bpm',
  'key',
  'noop', // diagnostic: runs the full pipeline without analyzing anything
] as const;

const knownAnalysisSet = new Set<string>(KNOWN_ANALYSES);

/** Accept only http(s) URLs (SSRF range checks happen at fetch time, M1). */
const httpUrl = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'must be an http(s) URL' },
);

export const transcodeOutputSchema = z.object({
  putUrl: httpUrl,
  format: z.enum(['mp3', 'opus']), // AAC is never permitted (licensing policy).
  bitrateKbps: z.number().int().positive(),
  targetLufs: z.number().optional(),
});

// A .dat/json peaks artifact holds exactly ONE zoom level, so each requested
// level carries its own signed PUT URL (see docs/decisions/0004).
export const peaksOutputSchema = z.object({
  format: z.enum(['audiowaveform-dat', 'json']),
  levels: z
    .array(
      z.object({
        /** Samples per pixel (audiowaveform -z); 2 is the tool's minimum. */
        zoom: z.number().int().min(2),
        putUrl: httpUrl,
      }),
    )
    .nonempty()
    .max(8),
  bits: z.union([z.literal(8), z.literal(16)]).optional(),
});

export const jobRequestSchema = z.object({
  jobId: z.string().min(1),
  source: z.object({
    url: httpUrl,
    contentHash: z
      .string()
      .regex(/^(sha1|sha256):[0-9a-f]+$/i, 'must be "sha1:<hex>" or "sha256:<hex>"')
      .optional(),
    filenameHint: z.string().min(1).optional(),
    maxBytes: z.number().int().positive().optional(),
  }),
  analyses: z.array(z.string().min(1)).nonempty(),
  outputs: z
    .object({
      transcode: transcodeOutputSchema.optional(),
      peaks: peaksOutputSchema.optional(),
    })
    .optional(),
  callback: z.object({ url: httpUrl }),
  limits: z
    .object({ timeoutMs: z.number().int().positive().optional() })
    .optional(),
});

export type JobRequest = z.infer<typeof jobRequestSchema>;

export type SemanticResult = { ok: true } | { ok: false; issues: string[] };

/** Analyses that require a matching entry under `outputs`. */
const OUTPUT_REQUIRED = ['transcode', 'peaks'] as const;

/**
 * Semantic validation beyond the structural schema. Failures map to 422.
 *
 * `available` is the set of analyses this build actually implements (the
 * analyzer registry). A contract-known but not-yet-implemented analysis is
 * rejected too — the engine never accepts work it cannot perform — with a
 * message that distinguishes the two cases.
 */
export function validateSemantics(
  job: JobRequest,
  available: ReadonlySet<string>,
): SemanticResult {
  const issues: string[] = [];

  for (const analysis of job.analyses) {
    if (!knownAnalysisSet.has(analysis)) {
      issues.push(`unsupported analysis: ${analysis}`);
    } else if (!available.has(analysis)) {
      issues.push(`analysis not available in this build: ${analysis}`);
    }
  }

  for (const name of OUTPUT_REQUIRED) {
    if (job.analyses.includes(name) && job.outputs?.[name] === undefined) {
      issues.push(`missing output slot: ${name}`);
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}
