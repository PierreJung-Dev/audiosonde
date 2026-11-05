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

  it('GET /readyz returns 200 ready (no binary required in M0)', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('ready');
  });
});
