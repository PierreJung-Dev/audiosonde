import type { FastifyInstance } from 'fastify';
import type { BinaryReport } from '../binaries.js';

export interface ReadyzDeps {
  getBinaries: () => Promise<BinaryReport>;
}

/**
 * Binaries that must be available for the engine to be "ready".
 * Empty in M0 (no analyzer runs yet) so dev without binaries isn't blocked;
 * tightened as analyzers land (e.g. ffmpeg/ffprobe from M2, audiowaveform M4).
 */
const REQUIRED_BINARIES: readonly (keyof BinaryReport)[] = [];

export function registerReadyz(app: FastifyInstance, deps: ReadyzDeps): void {
  // Readiness: 503 when a required binary is missing, so an orchestrator can
  // keep a broken container out of rotation (distinct from liveness).
  app.get('/readyz', async (_req, reply) => {
    const binaries = await deps.getBinaries();
    const missing = REQUIRED_BINARIES.filter((name) => !binaries[name].available);
    if (missing.length > 0) {
      return reply.code(503).send({ status: 'not_ready', missing, binaries });
    }
    return reply.code(200).send({ status: 'ready', binaries });
  });
}
