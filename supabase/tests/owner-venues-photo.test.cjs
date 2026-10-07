const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('./load-ts.cjs');

const { cleanPhoto } = load(path.resolve(__dirname, '../functions/owner-venues/photo.ts'), {}, { DataView });
let sharp = null;
try { sharp = require('sharp'); } catch { /* optional real-decoder checks */ }

const bytes = (...parts) => Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));
const segment = (marker, payload) => bytes([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload);
const includes = (haystack, text) => Buffer.from(haystack).includes(Buffer.from(text, 'latin1'));
/** Big-endian EXIF APP1 with Orientation, Make and a GPS IFD pointer. */
function exif(orientation) {
  const entries = [[0x0112, 3, 1, orientation << 16], [0x010f, 2, 4, 0x43616e00 /* "Can\0" */], [0x8825, 4, 1, 0x40]];
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
  ifd.writeUInt16BE(entries.length, 0);
  entries.forEach(([tag, type, count, value], index) => {
    ifd.writeUInt16BE(tag, 2 + index * 12); ifd.writeUInt16BE(type, 4 + index * 12);
    ifd.writeUInt32BE(count, 6 + index * 12); ifd.writeUInt32BE(value >>> 0, 10 + index * 12);
  });
  return segment(0xe1, bytes('Exif\0\0', [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8], ifd, 'GPS 14.5995N 120.9842E'));
}
function jpeg({ width = 640, height = 480, frame = 0xc0, orientation = 6, tail = 'trailing GPS 14.6,121' } = {}) {
  return bytes([0xff, 0xd8], exif(orientation), segment(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0])),
    segment(0xfe, 'secret comment'), segment(0xed, 'Photoshop 3.0\0IPTC owner name'),
    segment(0xe2, 'ICC_PROFILE\0\x01\x01display-p3'), segment(0xdb, Buffer.alloc(65, 1)),
    segment(frame, bytes([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])),
    segment(0xc4, Buffer.alloc(20, 2)), segment(0xda, bytes([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56], [0xff, 0xd9], tail);
}

test('JPEG: identifying metadata, profiles, comments and trailing data removed; orientation and pixels kept', () => {
  const result = cleanPhoto(new Uint8Array(jpeg()));
  assert.ok(result.ok);
  const out = Buffer.from(result.photo.bytes);
  assert.equal(result.photo.type, 'image/jpeg');
  assert.deepEqual([result.photo.width, result.photo.height], [480, 640], 'orientation 6 reports display dimensions');
  for (const leaked of ['GPS', 'Can', 'secret', 'IPTC', 'Photoshop', 'JFIF', 'trailing']) assert.ok(!includes(out, leaked), `${leaked} removed`);
  assert.ok(!includes(out, 'ICC_PROFILE') && !includes(out, 'display-p3'), 'ICC profiles may contain identifying text');
  assert.deepEqual([...out.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1], 'one-tag EXIF block follows SOI');
  assert.equal(out.readUInt16BE(4), 34);
  assert.equal(out.readUInt16BE(22), 0x0112);
  assert.equal(out.readUInt16BE(30), 6, 'orientation value kept');
  assert.deepEqual([...out.subarray(-9)], [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9], 'scan data copied, then EOI');
  const upright = cleanPhoto(new Uint8Array(jpeg({ orientation: 1 })));
  assert.ok(upright.ok && !includes(upright.photo.bytes, 'Exif') && upright.photo.width === 640, 'upright photos keep no EXIF at all');
});

test('rejects non-images, malformed files, unsupported encodings and out-of-range sizes before storage', () => {
  const problem = (input) => { const r = cleanPhoto(new Uint8Array(input)); return r.ok ? 'ok' : r.problem; };
  assert.equal(problem(bytes('GIF89a', Buffer.alloc(40))), 'unsupported_photo');
  assert.equal(problem(bytes('RIFF\0\0\0\0WEBPVP8 ', Buffer.alloc(40))), 'unsupported_photo');
  assert.equal(problem(bytes('%PDF-1.7\n<</Type/Catalog>>')), 'unsupported_photo');
  assert.equal(problem(bytes('<html><img src=x onerror=alert(1)>')), 'unsupported_photo');
  assert.equal(problem(jpeg({ frame: 0xc9 })), 'unsupported_photo', 'arithmetic coding');
  assert.equal(problem(jpeg({ frame: 0xc3 })), 'unsupported_photo', 'lossless');
  assert.equal(problem(jpeg().subarray(0, 300)), 'invalid_photo', 'truncated');
  assert.equal(problem(bytes([0xff, 0xd8, 0xff, 0xd9])), 'invalid_photo', 'no frame or scan');
  assert.equal(problem(bytes([0xff, 0xd8], segment(0xe1, 'x'), [0x00, 0x01])), 'invalid_photo', 'garbage between segments');
  assert.equal(problem(bytes([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xff])), 'invalid_photo', 'segment longer than the file');
  assert.equal(problem(jpeg({ width: 319, height: 900 })), 'photo_dimensions');
  assert.equal(problem(jpeg({ width: 8193, height: 900 })), 'photo_dimensions');
  assert.equal(problem(jpeg({ width: 6000, height: 5000 })), 'photo_dimensions', 'pixel budget');
  assert.equal(problem(Buffer.alloc(5 * 1024 * 1024 + 1, 0xff)), 'photo_too_large');
  const png = (...chunks) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ...chunks);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const content = bytes(type, data); let value = 0xffffffff;
    for (const byte of content) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
    return bytes(length, content, crc);
  };
  const ihdr = (w, h) => { const data = Buffer.alloc(13); data.writeUInt32BE(w, 0); data.writeUInt32BE(h, 4); data[8] = 8; data[9] = 2; return chunk('IHDR', data); };
  assert.equal(problem(png(chunk('tEXt', 'a\0b'), ihdr(640, 480), chunk('IDAT', 'x'), chunk('IEND', ''))), 'invalid_photo', 'IHDR first');
  assert.equal(problem(png(ihdr(640, 480), chunk('IEND', ''))), 'invalid_photo', 'no pixel data');
  assert.equal(problem(png(ihdr(640, 480), chunk('IDAT', 'x'))), 'invalid_photo', 'no end chunk');
  assert.equal(problem(png(ihdr(100000, 480), chunk('IDAT', 'x'), chunk('IEND', ''))), 'photo_dimensions');
  const corrupted = png(ihdr(640, 480), chunk('IDAT', 'pixels'), chunk('IEND', '')); corrupted[20] ^= 1;
  assert.equal(problem(corrupted), 'invalid_photo', 'corrupt dimensions fail CRC');
  assert.equal(problem(png(ihdr(640, 480), chunk('HIDE', 'secret'), chunk('IDAT', 'pixels'), chunk('IEND', ''))), 'unsupported_photo', 'unknown critical chunks');
  assert.equal(problem(png(ihdr(640, 480), chunk('IDAT', 'x'), chunk('IEND', 'secret'))), 'invalid_photo', 'IEND cannot carry a payload');
  const cleaned = cleanPhoto(new Uint8Array(png(ihdr(640, 480), chunk('tEXt', 'Author\0Owner Name'), chunk('eXIf', 'GPS'), chunk('tIME', '1234567'),
    chunk('IDAT', 'pixels'), chunk('iTXt', 'XML:com.adobe.xmp\0secret'), chunk('IEND', ''), 'trailing')));
  assert.ok(cleaned.ok && cleaned.photo.type === 'image/png' && cleaned.photo.width === 640);
  for (const leaked of ['Owner Name', 'GPS', 'tIME', 'xmp', 'trailing']) assert.ok(!includes(cleaned.photo.bytes, leaked), `${leaked} removed`);
  assert.ok(includes(cleaned.photo.bytes, 'pixels'));
});

test('real encoders: sanitized JPEG (baseline, progressive) and PNG decode to identical pixels without metadata', { skip: !sharp && 'sharp is not installed' }, async () => {
  const source = sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 63, b: 124 } } })
    .composite([{ input: Buffer.from('<svg width="800" height="600"><circle cx="300" cy="200" r="150" fill="#D6F22E"/></svg>') }]);
  const raw = async (input) => (await sharp(input).raw().toBuffer({ resolveWithObject: true }));
  for (const progressive of [false, true]) {
    const original = await source.clone().jpeg({ progressive, quality: 85 })
      .withExif({ IFD0: { Make: 'PicklyTestCam', Artist: 'Owner Name', Copyright: 'Private' }, IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' } })
      .withMetadata({ orientation: 6 }).toBuffer();
    const before = await sharp(original).metadata();
    assert.ok(before.exif && includes(before.exif, 'PicklyTestCam'), 'fixture really carries EXIF');
    const result = cleanPhoto(new Uint8Array(original));
    assert.ok(result.ok, `progressive=${progressive}`);
    assert.deepEqual([result.photo.width, result.photo.height], [600, 800]);
    const after = await sharp(Buffer.from(result.photo.bytes)).metadata();
    assert.equal(after.orientation, 6);
    assert.ok(!includes(result.photo.bytes, 'PicklyTestCam') && !includes(result.photo.bytes, 'Owner Name') && !includes(result.photo.bytes, 'Private'));
    assert.ok(after.exif.length < 40, 'only the orientation tag remains');
    const [a, b] = [await raw(original), await raw(Buffer.from(result.photo.bytes))];
    assert.ok(a.data.equals(b.data), `identical decoded pixels (progressive=${progressive})`);
  }
  const png = await source.clone().png().withMetadata().withExif({ IFD0: { Artist: 'Owner Name' } }).toBuffer();
  const cleaned = cleanPhoto(new Uint8Array(png));
  assert.ok(cleaned.ok && cleaned.photo.width === 800 && cleaned.photo.height === 600);
  assert.ok(!includes(cleaned.photo.bytes, 'Owner Name'));
  assert.ok((await raw(png)).data.equals((await raw(Buffer.from(cleaned.photo.bytes))).data), 'identical PNG pixels');
});
