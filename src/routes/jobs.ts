import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { SIGNATURE_HEADER, verifySignature } from '../hmac.js';
import { jobRequestSchema, validateSemantics } from '../schema/job.js';

export interface JobsDeps {
  config: Config;
}

export function registerJobs(app: FastifyInstance, deps: JobsDeps): void {
  const { config } = deps;

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

      const semantic = validateSemantics(parsed.data);
      if (!semantic.ok) {
        return reply.code(422).send({ error: 'unprocessable', issues: semantic.issues });
      }

      // M0: accept only. The processing pipeline (fetch → analyze → upload →
      // callback) is wired in M1; failures will be reported via the callback.
      return reply.code(202).send({ accepted: true, jobId: parsed.data.jobId });
    },
  );
}
