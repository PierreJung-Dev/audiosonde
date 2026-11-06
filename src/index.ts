import type { BinaryReport } from './binaries.js';
import { resolveBinaries } from './binaries.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { ENGINE_VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Share one binary resolution between the boot log and /healthz · /readyz.
  let binariesPromise: Promise<BinaryReport> | undefined;
  const resolve = (): Promise<BinaryReport> => (binariesPromise ??= resolveBinaries(config));

  const app = buildServer({ config, resolveBinaries: resolve });

  app.log.info(
    {
      engineVersion: ENGINE_VERSION,
      acceptedSecrets: config.acceptedSecrets.length,
      limits: {
        maxConcurrentJobs: config.maxConcurrentJobs,
        maxSourceBytes: config.maxSourceBytes,
        maxDurationMs: config.maxDurationMs,
        jobTimeoutMs: config.jobTimeoutMs,
        signatureToleranceSeconds: config.signatureToleranceSeconds,
      },
    },
    'audiosonde starting',
  );
  app.log.info({ binaries: await resolve() }, 'resolved binaries');

  // Graceful shutdown: stop accepting, drain in-flight jobs (callbacks +
  // tmp cleanup run in the server's onClose hook), then exit. Orchestrator
  // grace periods are usually shorter than a worst-case job — anything still
  // running when the platform sends SIGKILL is lost, as the durability model
  // documents (callers own reconciliation).
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down: draining in-flight jobs');
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'shutdown error');
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  // Fail-closed: any boot error (e.g. missing AUDIOSONDE_SECRET) exits non-zero.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
