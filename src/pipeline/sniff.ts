/**
 * Magic-bytes audio container detection. The extension and Content-Type header
 * are NEVER trusted (see docs/architecture.md, untrusted input discipline);
 * only the leading bytes of the downloaded file decide whether it even looks
 * like audio. Decoding correctness is ffmpeg's job later — this is the cheap
 * first gate that turns junk into `UNSUPPORTED_FORMAT` instead of a subprocess
 * error.
 */

export const SNIFF_BYTES = 16;

export type SniffedContainer =
  | 'wav'
  | 'flac'
  | 'mp3'
  | 'ogg'
  | 'aiff'
  | 'mp4'
  | 'asf'
  | 'wavpack'
  | 'ape';

const ASF_GUID = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]);

function ascii(buf: Buffer, start: number, text: string): boolean {
  return buf.length >= start + text.length && buf.toString('latin1', start, start + text.length) === text;
}

/** Detect the audio container from the file's first bytes, or null. */
export function sniffAudio(buf: Buffer): SniffedContainer | null {
  if (buf.length < 4) return null;

  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WAVE')) return 'wav';
  if (ascii(buf, 0, 'fLaC')) return 'flac';
  if (ascii(buf, 0, 'OggS')) return 'ogg';
  if (ascii(buf, 0, 'FORM') && (ascii(buf, 8, 'AIFF') || ascii(buf, 8, 'AIFC'))) return 'aiff';
  if (ascii(buf, 4, 'ftyp')) return 'mp4';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(ASF_GUID)) return 'asf';
  if (ascii(buf, 0, 'wvpk')) return 'wavpack';
  if (ascii(buf, 0, 'MAC ')) return 'ape';
  // ID3v2 tag: almost always an MP3 in the wild (ffprobe decides for real).
  if (ascii(buf, 0, 'ID3')) return 'mp3';
  // Bare MPEG audio frame sync: 11 set bits.
  const b0 = buf[0];
  const b1 = buf[1];
  if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0) return 'mp3';

  return null;
}
