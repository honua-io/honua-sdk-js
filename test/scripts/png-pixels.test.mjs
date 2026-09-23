import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { countInkPixels, decodePng } from "../../scripts/lib/png-pixels.mjs";

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Independent encoder: applies `filterFor(y)` to each scanline of raw channel samples. */
function encodePng({ width, height, colorType, samples, filterFor = () => 0 }) {
  const channels = CHANNELS[colorType];
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = filterFor(y);
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const value = samples[y * stride + x];
      const left = x >= channels ? samples[y * stride + x - channels] : 0;
      const up = y > 0 ? samples[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? samples[(y - 1) * stride + x - channels] : 0;
      const paeth = (() => {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      })();
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      raw[y * (stride + 1) + 1 + x] = (value - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("decodes every scanline filter to the exact RGBA raster", () => {
  const width = 7, height = 5;
  const samples = Array.from({ length: width * height * 4 }, (_, index) => (index * 37 + 11) % 256);
  const png = encodePng({ width, height, colorType: 6, samples, filterFor: (y) => y % 5 });
  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual([...decoded.rgba], samples);
});

test("expands truecolour, greyscale and greyscale-alpha to RGBA", () => {
  const rgb = decodePng(encodePng({ width: 2, height: 1, colorType: 2, samples: [10, 20, 30, 40, 50, 60], filterFor: () => 1 }));
  assert.deepEqual([...rgb.rgba], [10, 20, 30, 255, 40, 50, 60, 255]);
  const grey = decodePng(encodePng({ width: 2, height: 1, colorType: 0, samples: [0, 200], filterFor: () => 4 }));
  assert.deepEqual([...grey.rgba], [0, 0, 0, 255, 200, 200, 200, 255]);
  const greyAlpha = decodePng(encodePng({ width: 1, height: 2, colorType: 4, samples: [90, 128, 91, 0], filterFor: () => 2 }));
  assert.deepEqual([...greyAlpha.rgba], [90, 90, 90, 128, 91, 91, 91, 0]);
});

test("refuses what it cannot decode instead of guessing", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);
  const palette = encodePng({ width: 1, height: 1, colorType: 2, samples: [1, 2, 3] });
  palette[8 + 8 + 9] = 3; // IHDR colour type -> indexed
  assert.throws(() => decodePng(palette), /unsupported PNG/);
});

test("counts ink against a background, skipping transparent pixels, inside a box", () => {
  // 4x2: white, red, transparent black, near-white / red, white, red, white
  const samples = [
    255, 255, 255, 255, 217, 63, 63, 255, 0, 0, 0, 0, 250, 250, 250, 255,
    217, 63, 63, 255, 255, 255, 255, 255, 217, 63, 63, 255, 255, 255, 255, 255,
  ];
  const raster = decodePng(encodePng({ width: 4, height: 2, colorType: 6, samples }));
  const all = countInkPixels(raster);
  assert.equal(all.ink, 3);
  assert.deepEqual(all.dominant, [{ rgb: "217,63,63", count: 3 }]);
  assert.equal(countInkPixels(raster, { box: [0, 0, 2, 1] }).ink, 1);
  assert.equal(countInkPixels(raster, { tolerance: 0 }).ink, 4, "near-white counts once tolerance is zero");
});
