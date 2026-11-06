import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { signPayload } from '../src/hmac.js';
import { Metrics } from '../src/metrics.js';
import { fakeResolveBinaries, TEST_SECRET, testConfig } from './helpers.js';
import { makeTestWav } from './fixtures.js';
import { MockCaller, loopbackAllowedPolicy } from './mock-caller.js';

describe('Metrics (unit)', () => {
  it('renders every series zeroed, then reflects increments', () => {
    const m = new Metrics();
    const zeroed = m.render(0);
    expect(zeroed).toContain('audiosonde_jobs_in_flight 0');
    expect(zeroed).toContain('audiosonde_jobs_accepted_total 0');
    expect(zeroed).toContain('audiosonde_jobs_completed_total{status="done"} 0');
    expect(zeroed).toContain('audiosonde_job_errors_total{code="TIMEOUT"} 0');

    m.jobAccepted();
    m.jobRejected();
    m.jobCompleted('partial', 1500);
    m.jobError('ARTIFACT_UPLOAD_FAILED');
    m.callbackOutcome(true);
    m.callbackOutcome(false);

    const out = m.render(2);
    expect(out).toContain('audiosonde_jobs_in_flight 2');
    expect(out).toContain('audiosonde_jobs_accepted_total 1');
    expect(out).toContain('audiosonde_jobs_rejected_total 1');
    expect(out).toContain('audiosonde_jobs_completed_total{status="partial"} 1');
    expect(out).toContain('audiosonde_job_errors_total{code="ARTIFACT_UPLOAD_FAILED"} 1');
    expect(out).toContain('audiosonde_callbacks_total{outcome="delivered"} 1');
    expect(out).toContain('audiosonde_callbacks_total{outcome="failed"} 1');
    expect(out).toContain('audiosonde_job_duration_seconds_sum 1.5');
    expect(out).toContain('audiosonde_job_duration_seconds_count 1');
  });
});

describe('GET /metrics (integration)', () => {
  let caller: MockCaller;
  let app: FastifyInstance;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'audiosonde-metrics-'));
    caller = new MockCaller();
    await caller.start();
    caller.serve('/good.wav', { data: makeTestWav() });
    app = buildServer({
      config: { ...testConfig, maxSourceBytes: 1024 * 1024 },
      loggerEnabled: false,
      resolveBinaries: fakeResolveBinaries,
      addressPolicy: loopbackAllowedPolicy,
      tmpRoot,
      callbackBaseDelayMs: 1,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await caller.stop();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('counts an accepted job through to a delivered callback', async () => {
    const payload = JSON.stringify({
      jobId: 'metrics-job',
      source: { url: caller.url('/good.wav') },
      analyses: ['noop'],
      callback: { url: caller.url('/callback') },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        'content-type': 'application/json',
        'x-audiosonde-signature': signPayload(TEST_SECRET, payload),
      },
      payload,
    });
    expect(res.statusCode).toBe(202);
    await caller.waitForCallbacks(1);

    // Every outbound request identifies itself (UA-less requests get 403 from
    // several CDNs — the callback travels the same safeRequest path).
    expect(caller.callbacks[0]?.headers['user-agent']).toMatch(/^audiosonde\//);

    // The delivered counter increments just AFTER the callback response lands
    // at the mock caller — poll the scrape briefly instead of racing it.
    const deadline = Date.now() + 5000;
    let scrape = await app.inject({ method: 'GET', url: '/metrics' });
    while (
      !scrape.body.includes('audiosonde_callbacks_total{outcome="delivered"} 1') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      scrape = await app.inject({ method: 'GET', url: '/metrics' });
    }
    expect(scrape.statusCode).toBe(200);
    expect(scrape.headers['content-type']).toContain('text/plain');
    expect(scrape.body).toContain('audiosonde_jobs_accepted_total 1');
    expect(scrape.body).toContain('audiosonde_jobs_completed_total{status="done"} 1');
    expect(scrape.body).toContain('audiosonde_callbacks_total{outcome="delivered"} 1');
    expect(scrape.body).toContain('audiosonde_job_duration_seconds_count 1');
  });

  it('is absent when METRICS_ENABLED=false', async () => {
    const disabled = buildServer({
      config: { ...testConfig, metricsEnabled: false },
      loggerEnabled: false,
      resolveBinaries: fakeResolveBinaries,
    });
    await disabled.ready();
    const res = await disabled.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    await disabled.close();
  });
});
