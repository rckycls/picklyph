import { MAX_PHOTO_BYTES, photoDimensionsAllowed, type PhotoType } from '../../../packages/domain/src/ownerVenues.ts';

export type CleanPhoto = { type: PhotoType; bytes: Uint8Array; width: number; height: number };
export type PhotoProblem = 'photo_too_large' | 'unsupported_photo' | 'invalid_photo' | 'photo_dimensions';

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const EXIF = ascii('Exif\0\0');
const ADOBE = ascii('Adobe');
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
// Baseline, extended and progressive Huffman frames: what phones and browsers decode.
const FRAMES = new Set([0xc0, 0xc1, 0xc2]);
const TABLES = new Set([0xc4, 0xdb, 0xdd]); // DHT, DQT, DRI
// Pixel and colour chunks only; text, time, EXIF, animation and private chunks are dropped.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'IDAT', 'IEND']);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** EXIF IFD0 Orientation (1–8), or null when absent or malformed. */
function exifOrientation(payload: Uint8Array): number | null {
  if (payload.length < 14 || !startsWith(payload, EXIF)) return null;
  const tiff = new DataView(payload.buffer, payload.byteOffset + 6, payload.length - 6);
  const order = tiff.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  if (tiff.getUint16(2, little) !== 42) return null;
  const ifd = tiff.getUint32(4, little);
  if (ifd + 2 > tiff.byteLength) return null;
  const count = tiff.getUint16(ifd, little);
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.byteLength) return null;
    if (tiff.getUint16(entry, little) !== 0x0112) continue;
    const value = tiff.getUint16(entry + 8, little);
    return tiff.getUint16(entry + 2, little) === 3 && value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** A one-tag EXIF block: Orientation only, nothing that identifies a place, person or device. */
function orientationSegment(value: number): Uint8Array {
  return Uint8Array.of(0xff, 0xe1, 0x00, 0x22, ...EXIF,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at 8
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, value, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00); // no next IFD
}

function cleanJpeg(input: Uint8Array): CleanPhoto | PhotoProblem {
  const parts: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let orientation = 1;
  let frame: { width: number; height: number } | null = null;
  let scanned = false;
  let offset = 2;
  for (;;) {
    if (offset >= input.length || input[offset] !== 0xff) return 'invalid_photo';
    while (input[offset] === 0xff) offset++; // fill bytes
    if (offset >= input.length) return 'invalid_photo';
    const marker = input[offset++]!;
    if (marker === 0xd9) {
      if (!frame || !scanned) return 'invalid_photo';
      parts.push(Uint8Array.of(0xff, 0xd9));
      break; // anything after the end marker is dropped
    }
    if (offset + 2 > input.length) return 'invalid_photo';
    const length = (input[offset]! << 8) | input[offset + 1]!;
    const end = offset + length;
    if (length < 2 || end > input.length) return 'invalid_photo';
    const payload = input.subarray(offset + 2, end);
    const segment = input.subarray(offset - 2, end);
    offset = end;
    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(payload) ?? 1;
      // ICC profiles can carry free-text authors/copyright. Drop them too.
      // Adobe's fixed-size transform has only colour-decoding fields, no free text.
      if (marker === 0xee && payload.length === 12 && startsWith(payload, ADOBE)) parts.push(segment);
      continue;
    }
    if (marker === 0xfe || (marker >= 0xf0 && marker <= 0xfd)) continue; // comments, extensions
    if (FRAMES.has(marker)) {
      if (frame || payload.length < 6 || payload.length !== 6 + 3 * payload[5]!) return 'invalid_photo';
      if (payload[0] !== 8 || ![1, 3, 4].includes(payload[5]!)) return 'unsupported_photo';
      frame = { height: (payload[1]! << 8) | payload[2]!, width: (payload[3]! << 8) | payload[4]! };
      parts.push(segment);
      continue;
    }
    if (TABLES.has(marker)) { parts.push(segment); continue; }
    if (marker !== 0xda) return 'unsupported_photo'; // arithmetic, lossless, hierarchical or unknown
    if (!frame) return 'invalid_photo';
    parts.push(segment);
    // Entropy-coded data runs to the next marker other than stuffing (FF00) and restarts (FFD0–D7).
    let cursor = offset;
    while (cursor < input.length) {
      if (input[cursor] === 0xff) {
        const next = input[cursor + 1];
        if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { cursor += 2; continue; }
        break;
      }
      cursor++;
    }
    if (cursor >= input.length) return 'invalid_photo';
    parts.push(input.subarray(offset, cursor));
    offset = cursor;
    scanned = true;
  }
  if (!frame) return 'invalid_photo';
  if (orientation !== 1) parts.splice(1, 0, orientationSegment(orientation));
  // Orientations 5–8 rotate by 90°, so the displayed width is the stored height.
  const turned = orientation >= 5;
  return { type: 'image/jpeg', bytes: concat(parts), width: turned ? frame.height : frame.width, height: turned ? frame.width : frame.height };
}

function cleanPng(input: Uint8Array): CleanPhoto | PhotoProblem {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  let size: { width: number; height: number } | null = null;
  let pixels = false;
  let pixelsEnded = false;
  let palette = false;
  let color = 0;
  let offset = PNG_SIGNATURE.length;
  for (;;) {
    if (offset + 12 > input.length) return 'invalid_photo';
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > input.length) return 'invalid_photo';
    const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) return 'invalid_photo';
    if (crc(input.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) return 'invalid_photo';
    if (!size) {
      if (type !== 'IHDR' || length !== 13) return 'invalid_photo';
      size = { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12) };
      color = input[offset + 17]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(input[offset + 16]!) || input[offset + 18] !== 0 || input[offset + 19] !== 0
        || ![0, 1].includes(input[offset + 20]!)) return 'unsupported_photo';
    } else if (type === 'IHDR') return 'invalid_photo';
    if (type === 'PLTE') {
      if (palette || pixels || length < 3 || length > 768 || length % 3 !== 0 || color === 0 || color === 4) return 'invalid_photo';
      palette = true;
    }
    if (type === 'IDAT') {
      if (pixelsEnded || (color === 3 && !palette)) return 'invalid_photo';
      pixels = true;
    } else if (pixels) pixelsEnded = true;
    if (type === 'IEND' && length !== 0) return 'invalid_photo';
    if ((type === 'gAMA' && length !== 4) || (type === 'cHRM' && length !== 32) || (type === 'sRGB' && length !== 1)
      || (type === 'tRNS' && (pixels || (color === 0 ? length !== 2 : color === 2 ? length !== 6 : color === 3 ? !palette || length < 1 || length > 256 : true)))) return 'invalid_photo';
    if (!PNG_KEEP.has(type) && type[0] === type[0]!.toUpperCase()) return 'unsupported_photo';
    if (PNG_KEEP.has(type)) parts.push(input.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break; // anything after the end chunk is dropped
  }
  if (!size || !pixels) return 'invalid_photo';
  return { type: 'image/png', bytes: concat(parts), ...size };
}

/**
 * Identifies a JPEG or PNG from its bytes (never a client name or type) and rebuilds it
 * without metadata: EXIF (GPS, device, times), XMP, IPTC, comments, embedded thumbnails,
 * ICC profiles, PNG text/time/EXIF chunks and trailing data. Compressed pixels are copied, not re-encoded,
 * so this stays within an Edge function's CPU budget. Width/height are display dimensions.
 */
export function cleanPhoto(input: Uint8Array): { ok: true; photo: CleanPhoto } | { ok: false; problem: PhotoProblem } {
  if (input.length > MAX_PHOTO_BYTES) return { ok: false, problem: 'photo_too_large' };
  const cleaned = input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff ? cleanJpeg(input)
    : startsWith(input, PNG_SIGNATURE) ? cleanPng(input) : 'unsupported_photo';
  if (typeof cleaned === 'string') return { ok: false, problem: cleaned };
  if (!photoDimensionsAllowed(cleaned.width, cleaned.height)) return { ok: false, problem: 'photo_dimensions' };
  return { ok: true, photo: cleaned };
}
