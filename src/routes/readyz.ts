import type { FastifyInstance } from 'fastify';
import type { BinaryReport } from '../binaries.js';

export interface ReadyzDeps {
  getBinaries: () => Promise<BinaryReport>;
}

/**
 * Binaries that must be available for the engine to be "ready".
 * Grows as analyzers land: ffprobe since M2 (metadata), ffmpeg from M3
 * (loudness/transcode), audiowaveform from M4 (peaks).
 */
const REQUIRED_BINARIES: readonly (keyof BinaryReport)[] = ['ffprobe'];

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
