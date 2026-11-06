import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('fails closed when the secret is missing', () => {
    expect(() => loadConfig({})).toThrow(/AUDIOSONDE_SECRET/);
  });

  it('fails closed when the secret is empty', () => {
    expect(() => loadConfig({ AUDIOSONDE_SECRET: '' })).toThrow(/AUDIOSONDE_SECRET/);
  });

  it('loads sane defaults with only a secret', () => {
    const config = loadConfig({ AUDIOSONDE_SECRET: 's' });
    expect(config.signingSecret).toBe('s');
    expect(config.acceptedSecrets).toEqual(['s']);
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.maxConcurrentJobs).toBe(4);
    expect(config.signatureToleranceSeconds).toBe(300);
    expect(config.binaries.ffmpeg).toBe('ffmpeg');
  });

  it('accepts a previous secret for rotation', () => {
    const config = loadConfig({ AUDIOSONDE_SECRET: 'new', AUDIOSONDE_SECRET_PREVIOUS: 'old' });
    expect(config.signingSecret).toBe('new');
    expect(config.acceptedSecrets).toEqual(['new', 'old']);
  });

  it('coerces numeric env vars', () => {
    const config = loadConfig({ AUDIOSONDE_SECRET: 's', PORT: '3000', MAX_CONCURRENT_JOBS: '8' });
    expect(config.port).toBe(3000);
    expect(config.maxConcurrentJobs).toBe(8);
  });

  it('rejects invalid numeric env vars', () => {
    expect(() => loadConfig({ AUDIOSONDE_SECRET: 's', PORT: '-1' })).toThrow();
  });

  it('parses METRICS_ENABLED strictly (default true, "false" disables, junk rejected)', () => {
    expect(loadConfig({ AUDIOSONDE_SECRET: 's' }).metricsEnabled).toBe(true);
    expect(loadConfig({ AUDIOSONDE_SECRET: 's', METRICS_ENABLED: 'false' }).metricsEnabled).toBe(false);
    expect(loadConfig({ AUDIOSONDE_SECRET: 's', METRICS_ENABLED: 'true' }).metricsEnabled).toBe(true);
    expect(() => loadConfig({ AUDIOSONDE_SECRET: 's', METRICS_ENABLED: 'yes' })).toThrow();
  });
});
