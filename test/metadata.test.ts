import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metadataAnalyzer, type MetadataResult } from '../src/analyzers/metadata.js';
import { JobFailure } from '../src/errors.js';
import { FIXTURES, fixturePath } from './fixture-gen.js';
import { makeAnalyzerContext } from './helpers.js';

/**
 * M2 golden tests across the ffmpeg-generated fixture matrix. Exact asserts
 * for byte-derived facts (rate, channels, depth, codec, container, tags);
 * tolerances for encoder-dependent ones (duration, bitrate) so brew and
 * Docker ffmpeg versions both pass.
 */

async function analyze(
  file: string,
  container: Parameters<typeof makeAnalyzerContext>[1],
): Promise<MetadataResult> {
  const ctx = makeAnalyzerContext(fixturePath(file), container);
  return (await metadataAnalyzer.run(ctx)) as MetadataResult;
}

describe('metadata analyzer (golden fixtures)', () => {
  it('wav · 44.1 kHz · s16 · stereo', async () => {
    const m = await analyze(FIXTURES.wav16, 'wav');
    expect(m).toMatchObject({
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      container: 'wav',
      codec: 'pcm_s16le',
    });
    expect(m.durationMs).toBeGreaterThanOrEqual(950);
    expect(m.durationMs).toBeLessThanOrEqual(1050);
    // 44100 × 2ch × 16bit ≈ 1411 kbps (+ header overhead)
    expect(m.bitrateKbps).toBeGreaterThanOrEqual(1350);
    expect(m.bitrateKbps).toBeLessThanOrEqual(1480);
  });

  it('wav · 48 kHz · s24 · mono', async () => {
    const m = await analyze(FIXTURES.wav24, 'wav');
    expect(m).toMatchObject({
      sampleRate: 48000,
      channels: 1,
      bitDepth: 24,
      container: 'wav',
      codec: 'pcm_s24le',
    });
  });

  it('wav · 8 kHz · u8 · mono (noise)', async () => {
    const m = await analyze(FIXTURES.wav8, 'wav');
    expect(m).toMatchObject({
      sampleRate: 8000,
      channels: 1,
      bitDepth: 8,
      container: 'wav',
      codec: 'pcm_u8',
    });
  });

  it('flac · tags round-trip', async () => {
    const m = await analyze(FIXTURES.flac, 'flac');
    expect(m).toMatchObject({
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      container: 'flac',
      codec: 'flac',
    });
    expect(m.tags['title']).toBe('Fixture Sine');
    expect(m.tags['artist']).toBe('audiosonde');
  });

  it('mp3 · lossy → bitDepth null · ID3 tags', async () => {
    const m = await analyze(FIXTURES.mp3, 'mp3');
    expect(m).toMatchObject({
      sampleRate: 44100,
      channels: 2,
      bitDepth: null,
      container: 'mp3',
      codec: 'mp3',
    });
    expect(m.durationMs).toBeGreaterThanOrEqual(900);
    expect(m.durationMs).toBeLessThanOrEqual(1200); // encoder padding
    expect(m.bitrateKbps).toBeGreaterThanOrEqual(170);
    expect(m.bitrateKbps).toBeLessThanOrEqual(210);
    expect(m.tags['title']).toBe('Fixture Sine');
    expect(m.tags['artist']).toBe('audiosonde');
  });

  it('ogg/vorbis · tags from the stream', async () => {
    const m = await analyze(FIXTURES.ogg, 'ogg');
    expect(m).toMatchObject({
      sampleRate: 48000,
      channels: 2,
      bitDepth: null,
      container: 'ogg',
      codec: 'vorbis',
    });
    expect(m.tags['title']).toBe('Fixture Sine');
    expect(m.tags['artist']).toBe('audiosonde');
  });
});

describe('metadata analyzer (corrupt input)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'audiosonde-corrupt-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function expectUnsupported(path: string, container: 'flac' | 'mp3'): Promise<void> {
    const ctx = makeAnalyzerContext(path, container);
    const err = await metadataAnalyzer.run(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JobFailure);
    expect((err as JobFailure).code).toBe('UNSUPPORTED_FORMAT');
  }

  it('valid magic bytes + garbage body → UNSUPPORTED_FORMAT, no crash', async () => {
    const path = join(dir, 'garbage.flac');
    // 'fLaC' magic (passes the sniff) followed by bytes no decoder accepts.
    await writeFile(path, Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(256, 0xa7)]));
    await expectUnsupported(path, 'flac');
  });

  it('truncated real file → UNSUPPORTED_FORMAT, no crash', async () => {
    const whole = await readFile(fixturePath(FIXTURES.flac));
    const path = join(dir, 'truncated.flac');
    await writeFile(path, whole.subarray(0, 96)); // cut inside the metadata blocks
    await expectUnsupported(path, 'flac');
  });

  it('no audio stream → UNSUPPORTED_FORMAT', async () => {
    // A bare MP3 sync pattern with nothing decodable behind it.
    const path = join(dir, 'sync-only.mp3');
    await writeFile(path, Buffer.from([0xff, 0xfb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    await expectUnsupported(path, 'mp3');
  });
});
