import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { SIGNATURE_HEADER, verifySignature } from '../hmac.js';
import { jobRequestSchema, validateSemantics } from '../schema/job.js';
import { AVAILABLE_ANALYSES } from '../analyzers/registry.js';
import type { JobRunner } from '../pipeline/runner.js';

export interface JobsDeps {
  config: Config;
  runner: JobRunner;
  /** Override the build's analysis set (tests simulate smaller builds). */
  availableAnalyses?: ReadonlySet<string>;
}

export function registerJobs(app: FastifyInstance, deps: JobsDeps): void {
  const { config, runner } = deps;
  const availableAnalyses = deps.availableAnalyses ?? AVAILABLE_ANALYSES;

  app.post(
    '/v1/jobs',
    {
      preValidation: async (req, reply) => {
        const header = req.headers[SIGNATURE_HEADER];
        const signature = Array.isArray(header) ? header[0] : header;
        const result = verifySignature(config.acceptedSecrets, req.rawBody ?? '', signature, {
          toleranceSeconds: config.signatureToleranceSeconds,
        });
        if (!result.ok) {
          return reply.code(401).send({ error: 'invalid_signature', reason: result.reason });
        }
        // Signature OK but body wasn't valid JSON → 400 (ordered after 401).
        if (req.jsonInvalid === true) {
          return reply.code(400).send({ error: 'invalid_json' });
        }
        return undefined;
      },
    },
    async (req, reply) => {
      const parsed = jobRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }

      const semantic = validateSemantics(parsed.data, availableAnalyses);
      if (!semantic.ok) {
        return reply.code(422).send({ error: 'unprocessable', issues: semantic.issues });
      }

      // Backpressure: reject (don't queue) when every concurrency slot is
      // busy — the caller's queue owns submission retry (see runner).
      if (!runner.tryStart(parsed.data)) {
        return reply
          .code(429)
          .header('retry-after', '2')
          .send({ error: 'over_capacity', maxConcurrentJobs: config.maxConcurrentJobs });
      }

      // Accepted for best-effort processing; outcomes arrive via the callback.
      return reply.code(202).send({ accepted: true, jobId: parsed.data.jobId });
    },
  );
}
