import type { FastifyInstance } from 'fastify';
import type { Metrics } from '../metrics.js';
import type { JobRunner } from '../pipeline/runner.js';

export interface MetricsDeps {
  metrics: Metrics;
  runner: JobRunner;
}

export function registerMetrics(app: FastifyInstance, deps: MetricsDeps): void {
  // Prometheus scrape endpoint. Unauthenticated like /healthz — it exposes
  // only aggregate counters over closed label sets, never job content or
  // URLs. Disable with METRICS_ENABLED=false if the port is exposed publicly.
  app.get('/metrics', async (_req, reply) => {
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(deps.metrics.render(deps.runner.active));
  });
}
