import type { FastifyInstance } from 'fastify';
import type { BinaryReport } from '../binaries.js';
import { ENGINE_VERSION } from '../version.js';

export interface HealthzDeps {
  getBinaries: () => Promise<BinaryReport>;
}

export function registerHealthz(app: FastifyInstance, deps: HealthzDeps): void {
  // Liveness + visibility: always 200 while the process is up. Also reports
  // the resolved binary versions so operators can see what the image ships.
  app.get('/healthz', async () => {
    const binaries = await deps.getBinaries();
    return { status: 'ok', version: ENGINE_VERSION, binaries };
  });
}
