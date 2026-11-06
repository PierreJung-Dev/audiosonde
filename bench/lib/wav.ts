import { readFileSync, writeFileSync } from 'node:fs';

/** Write a mono s16le PCM WAV file. */
export function writeWavS16(path: string, samples: Float32Array, sampleRate: number): void {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/** Read a mono s16le PCM WAV file (the only shape this bench produces). */
export function readWavS16Mono(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file: ${path}`);
  }
  let off = 12;
  let fmt: { tag: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        tag: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error(`data chunk before fmt chunk: ${path}`);
      if (fmt.tag !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
        throw new Error(`expected s16le mono, got tag=${fmt.tag} bits=${fmt.bits} ch=${fmt.channels}: ${path}`);
      }
      const count = Math.min(Math.floor(size / 2), Math.floor((buf.length - body) / 2));
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(body + i * 2) / 32768;
      return { samples: out, sampleRate: fmt.sampleRate };
    }
    off = body + size + (size % 2);
  }
  throw new Error(`no data chunk found: ${path}`);
}
