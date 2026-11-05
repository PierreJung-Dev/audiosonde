import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { fakeResolveBinaries, testConfig } from './helpers.js';

describe('health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer({
      config: testConfig,
      loggerEnabled: false,
      resolveBinaries: fakeResolveBinaries,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz returns status, version and binary versions', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      version: string;
      binaries: Record<string, { available: boolean; version: string | null }>;
    };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.binaries.ffmpeg).toEqual({ available: true, version: '6.1.1' });
    expect(body.binaries.ffprobe?.available).toBe(true);
    expect(body.binaries.audiowaveform?.version).toBe('1.10.3');
  });

  it('GET /readyz returns 200 ready when required binaries are present', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('ready');
  });

  it('GET /readyz returns 503 when a required binary is missing', async () => {
    const broken = buildServer({
      config: testConfig,
      loggerEnabled: false,
      resolveBinaries: () =>
        Promise.resolve({
          ffmpeg: { available: true, version: '6.1.1' },
          ffprobe: { available: false, version: null },
          audiowaveform: { available: true, version: '1.10.3' },
        }),
    });
    await broken.ready();
    const res = await broken.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; missing: string[] };
    expect(body.status).toBe('not_ready');
    expect(body.missing).toContain('ffprobe');
    await broken.close();
  });
});
