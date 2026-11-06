import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { signPayload } from '../src/hmac.js';
import { fakeResolveBinaries, TEST_SECRET, testConfig } from './helpers.js';

// `.invalid` is reserved (RFC 2606): accepted jobs may fire a background
// fetch, and these hostnames are guaranteed never to resolve — no test ever
// touches the real network.
const validJob = {
  jobId: 'job-1',
  source: { url: 'https://source.invalid/mix.wav' },
  analyses: ['noop'],
  callback: { url: 'https://callback.invalid/cb' },
};

function post(
  app: FastifyInstance,
  bodyObj: unknown,
  opts: { sign?: boolean; signature?: string } = {},
): ReturnType<FastifyInstance['inject']> {
  const payload = JSON.stringify(bodyObj);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.signature !== undefined) {
    headers['x-audiosonde-signature'] = opts.signature;
  } else if (opts.sign !== false) {
    headers['x-audiosonde-signature'] = signPayload(TEST_SECRET, payload);
  }
  return app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
}

describe('POST /v1/jobs', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer({
      config: testConfig,
      loggerEnabled: false,
      resolveBinaries: fakeResolveBinaries,
      callbackBaseDelayMs: 1, // accepted jobs fail fast on close
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('202 on a valid signed job', async () => {
    const res = await post(app, validJob);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, jobId: 'job-1' });
  });

  it('202 on a valid signed job with transcode + peaks output slots', async () => {
    const res = await post(app, {
      ...validJob,
      analyses: ['transcode', 'peaks'],
      outputs: {
        transcode: { putUrl: 'https://s3.invalid/put', format: 'opus', bitrateKbps: 128, targetLufs: -14 },
        peaks: {
          format: 'audiowaveform-dat',
          levels: [
            { zoom: 256, putUrl: 'https://s3.invalid/peaks-256' },
            { zoom: 1024, putUrl: 'https://s3.invalid/peaks-1024' },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(202);
  });

  it('422 when requesting a contract analysis not available in this build', async () => {
    // Every contract analysis is implemented as of M5, so simulate a smaller
    // build via the DI seam — the engine never accepts work it cannot perform.
    const smallBuild = buildServer({
      config: testConfig,
      loggerEnabled: false,
      resolveBinaries: fakeResolveBinaries,
      availableAnalyses: new Set(['metadata', 'noop']),
    });
    await smallBuild.ready();
    try {
      const res = await post(smallBuild, { ...validJob, analyses: ['bpm'] });
      expect(res.statusCode).toBe(422);
      const issues = (res.json() as { issues: string[] }).issues;
      expect(issues.some((i) => i.includes('not available in this build'))).toBe(true);
    } finally {
      await smallBuild.close();
    }
  });

  it('202 on a bpm + key job (available since M5)', async () => {
    const res = await post(app, { ...validJob, analyses: ['bpm', 'key'] });
    expect(res.statusCode).toBe(202);
  });

  it('400 on a peaks slot with no levels', async () => {
    const res = await post(app, {
      ...validJob,
      analyses: ['peaks'],
      outputs: { peaks: { format: 'json', levels: [] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on a malformed contentHash', async () => {
    const res = await post(app, {
      ...validJob,
      source: { url: 'https://source.invalid/mix.wav', contentHash: 'md5:abcdef' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 when the signature is missing', async () => {
    const res = await post(app, validJob, { sign: false });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_signature', reason: 'missing' });
  });

  it('401 when the signature is invalid', async () => {
    const res = await post(app, validJob, { signature: 't=1700000000,v1=deadbeef' });
    expect(res.statusCode).toBe(401);
  });

  it('400 on malformed JSON (signed over the raw body)', async () => {
    const raw = '{ not json';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        'content-type': 'application/json',
        'x-audiosonde-signature': signPayload(TEST_SECRET, raw),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('400 on a schema violation (missing jobId)', async () => {
    const res = await post(app, {
      source: { url: 'https://example.com/mix.wav' },
      analyses: ['metadata'],
      callback: { url: 'https://api.example.com/callback' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('400 on a non-http(s) source url', async () => {
    const res = await post(app, { ...validJob, source: { url: 'ftp://example.com/x.wav' } });
    expect(res.statusCode).toBe(400);
  });

  it('422 on an unknown analysis', async () => {
    const res = await post(app, { ...validJob, analyses: ['metadata', 'bogus'] });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'unprocessable' });
  });

  it('422 when transcode is requested without an output slot', async () => {
    const res = await post(app, { ...validJob, analyses: ['transcode'] });
    expect(res.statusCode).toBe(422);
  });
});
