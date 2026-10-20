// Minimal, dependency-free PNG decoder for receipt pixel assertions.
//
// Candidate receipts assert on rendered pixels, not on byte snapshots, so they
// need the decoded RGBA raster. This handles the non-interlaced 8-bit
// truecolour, truecolour-with-alpha, greyscale and greyscale-with-alpha PNGs
// the server renderers emit, and refuses everything else rather than guessing.
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
export function decodePng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let header;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8],
        colorType: data[9], interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");
  const channels = CHANNELS[header.colorType];
  if (header.bitDepth !== 8 || header.interlace !== 0 || !channels) {
    throw new Error(`unsupported PNG (bitDepth ${header.bitDepth}, colorType ${header.colorType}, interlace ${header.interlace})`);
  }
  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error("PNG scanline data has the wrong length");
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let predictor;
      switch (filter) {
        case 0: predictor = 0; break;
        case 1: predictor = left; break;
        case 2: predictor = up; break;
        case 3: predictor = (left + up) >> 1; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[x] = (line[x] + predictor) & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += channels, j += 4) {
    if (channels === 4) { pixels.copy(rgba, j, i, i + 4); continue; }
    if (channels === 3) { rgba[j] = pixels[i]; rgba[j + 1] = pixels[i + 1]; rgba[j + 2] = pixels[i + 2]; rgba[j + 3] = 255; continue; }
    rgba[j] = rgba[j + 1] = rgba[j + 2] = pixels[i];
    rgba[j + 3] = channels === 2 ? pixels[i + 1] : 255;
  }
  return { width, height, rgba };
}

/**
 * Counts pixels whose colour differs from `background` by more than
 * `tolerance` on any RGB channel, inside an optional [x0, y0, x1, y1) box.
 */
export function countInkPixels({ width, height, rgba }, { background = [255, 255, 255], tolerance = 24, box } = {}) {
  const [x0, y0, x1, y1] = box ?? [0, 0, width, height];
  let ink = 0;
  const colours = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] === 0) continue;
      if (Math.abs(rgba[i] - background[0]) > tolerance || Math.abs(rgba[i + 1] - background[1]) > tolerance || Math.abs(rgba[i + 2] - background[2]) > tolerance) {
        ink++;
        const key = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`;
        colours.set(key, (colours.get(key) ?? 0) + 1);
      }
    }
  }
  const dominant = [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([rgb, count]) => ({ rgb, count }));
  return { ink, pixels: (x1 - x0) * (y1 - y0), dominant };
}
