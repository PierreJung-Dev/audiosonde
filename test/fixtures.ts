/**
 * In-code test fixtures. NO audio file is ever committed (licensing policy
 * rule 4): byte-level fixtures are constructed here; richer fixtures (M2+)
 * are synthesized with ffmpeg at test bootstrap.
 */

/** A minimal valid RIFF/WAVE file: 16-bit mono 8 kHz PCM silence. */
export function makeTestWav(sampleCount = 1000): Buffer {
  const dataSize = sampleCount * 2;
  const buf = Buffer.alloc(44 + dataSize); // samples stay zero = silence
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(8000, 24); // sample rate
  buf.writeUInt32LE(16000, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}
