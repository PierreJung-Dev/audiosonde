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

export const peaksOutputSchema = z.object({
  putUrl: httpUrl,
  format: z.enum(['audiowaveform-dat', 'json']),
  zoomLevels: z.array(z.number().int().positive()).nonempty(),
});

export const jobRequestSchema = z.object({
  jobId: z.string().min(1),
  source: z.object({
    url: httpUrl,
    contentHash: z.string().min(1).optional(),
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
 */
export function validateSemantics(job: JobRequest): SemanticResult {
  const issues: string[] = [];

  for (const analysis of job.analyses) {
    if (!knownAnalysisSet.has(analysis)) {
      issues.push(`unsupported analysis: ${analysis}`);
    }
  }

  for (const name of OUTPUT_REQUIRED) {
    if (job.analyses.includes(name) && job.outputs?.[name] === undefined) {
      issues.push(`missing output slot: ${name}`);
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}
