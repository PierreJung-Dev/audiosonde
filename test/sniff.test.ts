import { describe, expect, it } from 'vitest';
import { sniffAudio } from '../src/pipeline/sniff.js';
import { makeTestWav } from './fixtures.js';

function bytes(...parts: (string | number[])[]): Buffer {
  return Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );
}

describe('sniffAudio', () => {
  it('detects wav (and the generated fixture)', () => {
    expect(sniffAudio(makeTestWav(8).subarray(0, 16))).toBe('wav');
    expect(sniffAudio(bytes('RIFF', [0, 0, 0, 0], 'WAVE', 'fmt '))).toBe('wav');
  });

  it('detects flac', () => {
    expect(sniffAudio(bytes('fLaC', [0, 0, 0, 34]))).toBe('flac');
  });

  it('detects ogg', () => {
    expect(sniffAudio(bytes('OggS', [0, 2, 0, 0]))).toBe('ogg');
  });

  it('detects mp3 via ID3v2 tag', () => {
    expect(sniffAudio(bytes('ID3', [4, 0, 0, 0, 0, 0, 0]))).toBe('mp3');
  });

  it('detects mp3 via MPEG frame sync', () => {
    expect(sniffAudio(bytes([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
    expect(sniffAudio(bytes([0xff, 0xe0, 0x00, 0x00]))).toBe('mp3');
  });

  it('detects aiff', () => {
    expect(sniffAudio(bytes('FORM', [0, 0, 0, 0], 'AIFF'))).toBe('aiff');
    expect(sniffAudio(bytes('FORM', [0, 0, 0, 0], 'AIFC'))).toBe('aiff');
  });

  it('detects mp4 family via ftyp', () => {
    expect(sniffAudio(bytes([0, 0, 0, 32], 'ftypM4A '))).toBe('mp4');
  });

  it('rejects RIFF that is not WAVE (e.g. AVI)', () => {
    expect(sniffAudio(bytes('RIFF', [0, 0, 0, 0], 'AVI ', [0, 0, 0, 0]))).toBeNull();
  });

  it('rejects non-audio bytes', () => {
    expect(sniffAudio(bytes('hello world, definitely not audio'))).toBeNull();
    expect(sniffAudio(bytes('<!DOCTYPE html><html>'))).toBeNull();
    expect(sniffAudio(bytes('%PDF-1.4'))).toBeNull();
    expect(sniffAudio(Buffer.alloc(0))).toBeNull();
    expect(sniffAudio(bytes([0x00, 0x01]))).toBeNull();
  });
});
