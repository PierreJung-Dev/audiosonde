import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { BinaryReport } from './binaries.js';
import { resolveBinaries } from './binaries.js';
import { registerHealthz } from './routes/healthz.js';
import { registerReadyz } from './routes/readyz.js';
import { registerJobs } from './routes/jobs.js';
import { JobRunner } from './pipeline/runner.js';
import type { AddressPolicy } from './net/ssrf.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    jsonInvalid?: boolean;
  }
}

export interface ServerDeps {
  config: Config;
  loggerEnabled?: boolean;
  /** Override binary resolution (tests inject a fake report). */
  resolveBinaries?: () => Promise<BinaryReport>;
  /**
   * Override the SSRF address policy (tests allow loopback so a local mock
   * caller can serve sources and receive callbacks). NEVER overridden in
   * production wiring — src/index.ts does not pass it.
   */
  addressPolicy?: AddressPolicy;
  /** Override the root for per-job tmp dirs (tests use a scratch dir). */
  tmpRoot?: string;
  /** Shrink the callback retry backoff base (tests). */
  callbackBaseDelayMs?: number;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger: deps.loggerEnabled ?? true,
    bodyLimit: 1024 * 1024,
  });

  // Capture the raw body (required for HMAC) while still parsing JSON. We do
  // NOT throw here on invalid JSON: the signature must be verified first
  // (401 before 400), so we flag the parse failure and let the route's
  // preValidation hook order the checks.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const raw = typeof body === 'string' ? body : String(body);
      req.rawBody = raw;
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw) as unknown);
      } catch {
        req.jsonInvalid = true;
        done(null, {});
      }
    },
  );

  // Resolve binary versions once and memoize (shared by /healthz and /readyz).
  const resolve = deps.resolveBinaries ?? ((): Promise<BinaryReport> => resolveBinaries(config));
  let cached: Promise<BinaryReport> | undefined;
  const getBinaries = (): Promise<BinaryReport> => (cached ??= resolve());

  const runner = new JobRunner({
    config,
    log: app.log,
    ...(deps.addressPolicy !== undefined ? { policy: deps.addressPolicy } : {}),
    ...(deps.tmpRoot !== undefined ? { tmpRoot: deps.tmpRoot } : {}),
    ...(deps.callbackBaseDelayMs !== undefined
      ? { callbackBaseDelayMs: deps.callbackBaseDelayMs }
      : {}),
  });

  // Graceful shutdown: let in-flight jobs finish their callback + cleanup.
  app.addHook('onClose', async () => {
    await runner.drain();
  });

  registerHealthz(app, { getBinaries });
  registerReadyz(app, { getBinaries });
  registerJobs(app, { config, runner });

  return app;
}
