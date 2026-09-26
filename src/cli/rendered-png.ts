/**
 * Decode a rendered map PNG and reject a style/render no-op.
 *
 * Same structural proof as the zero-to-map journey: chunk CRCs, exact inflated
 * raster size, Adam7 passes, visible pixels, and a non-flat image. A catalog
 * match cannot establish that a styled map was drawn.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/** Resolved expectations a fetched render artifact is judged against. */
export interface RenderedImageExpectation {
  readonly uri: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly minByteLength: number;
}

/** Proven properties of a fetched render artifact, retained as receipt evidence. */
export interface RenderedImageEvidence {
  readonly uri: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly imageSha256: string;
  /** Number of decoded pixels with nonzero alpha, across every Adam7 pass. */
  readonly visiblePixelCount: number;
  /** SHA-256 of row-major RGBA unsigned 16-bit big-endian decoded samples. */
  readonly decodedPixelSha256: string;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel for each PNG colour type; `undefined` marks a reserved value. */
const PNG_CHANNELS: Readonly<Record<number, number | undefined>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** PNG chunk CRC-32 over the type bytes followed by the chunk data. */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xff_ff_ff_ff;
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * Reverse the PNG per-scanline filters so the raster can be inspected as pixels
 * rather than as filtered bytes. Filter types are PNG spec 9.2; an unknown type
 * is a corrupt raster, not something to skip past.
 */
function unfilterRaster(
  raster: Uint8Array,
  height: number,
  bytesPerPixel: number,
  bytesPerRow: number,
  where: string,
): Uint8Array {
  const out = new Uint8Array(height * bytesPerRow);
  const step = Math.max(1, bytesPerPixel);
  for (let row = 0; row < height; row += 1) {
    const filter = raster[row * (bytesPerRow + 1)]!;
    const from = row * (bytesPerRow + 1) + 1;
    const to = row * bytesPerRow;
    const above = (row - 1) * bytesPerRow;
    for (let index = 0; index < bytesPerRow; index += 1) {
      const raw = raster[from + index]!;
      const left = index >= step ? out[to + index - step]! : 0;
      const up = row > 0 ? out[above + index]! : 0;
      const upLeft = row > 0 && index >= step ? out[above + index - step]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const dLeft = Math.abs(estimate - left);
          const dUp = Math.abs(estimate - up);
          const dUpLeft = Math.abs(estimate - upLeft);
          value = raw + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft);
          break;
        }
        default:
          throw new Error(`${where} uses unknown PNG filter type ${filter} on row ${row}; the raster is corrupt`);
      }
      out[to + index] = value & 0xff;
    }
  }
  return out;
}

/**
 * Validate that fetched bytes are a PNG of the declared size that actually
 * decodes to a drawn map.
 *
 * A style/render no-op is not a transport failure: the tool answers, the
 * resource resolves, and the bytes may even be a syntactically plausible PNG.
 * Structural checks alone are not enough to tell those apart - a blob whose
 * chunks are merely *labelled* IDAT passes any counter that only sums chunk
 * lengths, and a correctly-sized PNG of uniform background is a valid image
 * that proves nothing about the style under test. So this decodes: every chunk
 * CRC is verified, the stream must terminate in IEND, the concatenated IDAT
 * payload must inflate, the inflated raster must be exactly the size the IHDR
 * geometry implies, and the unfiltered pixels must not be a single flat colour.
 * Each failure names the artifact and the property that was not met.
 */
export function assertRenderedPng(
  bytes: Uint8Array,
  mediaType: string | undefined,
  expected: RenderedImageExpectation,
): RenderedImageEvidence {
  const where = `rendered artifact ${expected.uri}`;
  if (mediaType !== expected.mediaType) {
    throw new Error(`${where} declared media type ${mediaType}; expected ${expected.mediaType}`);
  }
  if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error(`${where} is not a PNG: the 8-byte PNG signature is absent`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | undefined;
  const idatParts: Uint8Array[] = [];
  let sawEnd = false;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    if (dataStart + length + 4 > bytes.length) {
      throw new Error(`${where} is truncated: chunk ${type} declares ${length} bytes past the end of the artifact`);
    }
    const declaredCrc = view.getUint32(dataStart + length);
    const actualCrc = crc32(bytes, offset + 4, dataStart + length);
    if (declaredCrc !== actualCrc) {
      throw new Error(
        `${where} fails its ${type} chunk CRC (declared ${declaredCrc.toString(16)}, computed ${actualCrc.toString(16)}); the artifact is corrupt and no decoder would accept it`,
      );
    }
    if (type === "IHDR") {
      if (length !== 13) throw new Error(`${where} has a malformed IHDR chunk: ${length} bytes, expected 13`);
      header = {
        width: view.getUint32(dataStart),
        height: view.getUint32(dataStart + 4),
        bitDepth: bytes[dataStart + 8]!,
        colorType: bytes[dataStart + 9]!,
        interlace: bytes[dataStart + 12]!,
      };
    } else if (type === "PLTE") {
      palette = bytes.subarray(dataStart, dataStart + length);
    } else if (type === "tRNS") {
      transparency = bytes.subarray(dataStart, dataStart + length);
    } else if (type === "IDAT") {
      idatParts.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = dataStart + length + 4;
  }

  if (!header) throw new Error(`${where} carries no IHDR chunk, so it declares no image dimensions`);
  if (!sawEnd) throw new Error(`${where} never terminates in an IEND chunk; the artifact is incomplete`);
  if (header.width !== expected.width || header.height !== expected.height) {
    throw new Error(
      `${where} is ${header.width}x${header.height}; the renderer reported ${expected.width}x${expected.height}`,
    );
  }
  const channels = PNG_CHANNELS[header.colorType];
  if (channels === undefined) throw new Error(`${where} declares reserved PNG colour type ${header.colorType}`);
  const idatBytes = idatParts.reduce((total, part) => total + part.length, 0);
  if (idatBytes === 0) {
    throw new Error(`${where} carries no IDAT pixel data: the artifact declares a canvas but nothing was drawn on it`);
  }

  const legalDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!legalDepths[header.colorType]?.includes(header.bitDepth) || ![0, 1].includes(header.interlace)) {
    throw new Error(`${where} declares an invalid PNG bit depth or interlace method`);
  }
  if (header.width < 1 || header.height < 1) throw new Error(`${where} has empty PNG dimensions`);
  if (header.colorType === 3 && (!palette || palette.length === 0 || palette.length % 3 !== 0)) {
    throw new Error(`${where} has no valid PNG palette`);
  }
  // Each Adam7 pass is its own filtered image. Decode all passes; interlacing
  // must never exempt a render from the raster-shape or visible-content proof.
  const layout =
    header.interlace === 1
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ]
      : [[0, 0, 1, 1]];
  const passes = layout.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((header.width - x!) / dx!));
    const height = Math.max(0, Math.ceil((header.height - y!) / dy!));
    const rowBytes = Math.ceil((width * channels * header.bitDepth) / 8);
    return {
      x: x!,
      y: y!,
      dx: dx!,
      dy: dy!,
      width,
      height,
      rowBytes,
      length: width && height ? height * (rowBytes + 1) : 0,
    };
  });
  const expectedRaster = passes.reduce((total, pass) => total + pass.length, 0);
  const compressed = Buffer.concat(idatParts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.length)));
  let raster: Buffer;
  try {
    raster = inflateSync(compressed, { maxOutputLength: expectedRaster + 1 });
  } catch (error) {
    throw new Error(
      `${where} has an IDAT stream that does not inflate within its declared raster size (${error instanceof Error ? error.message : String(error)}); no PNG decoder could render this artifact`,
    );
  }
  if (raster.length !== expectedRaster) {
    throw new Error(
      `${where} inflates to ${raster.length} raster bytes; the declared PNG needs exactly ${expectedRaster}`,
    );
  }
  const maxSample = (1 << header.bitDepth) - 1;
  const seen = new Set<string>();
  const decoded = Buffer.alloc(header.width * header.height * 8);
  let visiblePixelCount = 0;
  let passOffset = 0;
  for (const pass of passes) {
    if (!pass.length) continue;
    const pixels = unfilterRaster(
      raster.subarray(passOffset, passOffset + pass.length),
      pass.height,
      Math.ceil((channels * header.bitDepth) / 8),
      pass.rowBytes,
      where,
    );
    passOffset += pass.length;
    for (let row = 0; row < pass.height; row += 1) {
      for (let column = 0; column < pass.width; column += 1) {
        const samples = Array.from({ length: channels }, (_, channel) => {
          const bit = (column * channels + channel) * header.bitDepth;
          const at = row * pass.rowBytes + Math.floor(bit / 8);
          return header.bitDepth === 16
            ? pixels[at]! * 256 + pixels[at + 1]!
            : (pixels[at]! >> (8 - header.bitDepth - (bit % 8))) & maxSample;
        });
        let alpha = maxSample;
        let color = samples;
        if (header.colorType === 3) {
          const index = samples[0]!;
          if (!palette || index * 3 + 2 >= palette.length)
            throw new Error(`${where} references a missing PNG palette entry`);
          color = Array.from(palette.subarray(index * 3, index * 3 + 3));
          alpha = transparency?.[index] ?? 255;
        } else if (header.colorType === 4 || header.colorType === 6) {
          alpha = samples[samples.length - 1]!;
          color = samples.slice(0, -1);
        } else if (
          transparency &&
          samples.every(
            (sample, index) =>
              transparency[index * 2] !== undefined &&
              sample === transparency[index * 2]! * 256 + transparency[index * 2 + 1]!,
          )
        ) {
          alpha = 0;
        }
        const maximum = header.colorType === 3 ? 255 : maxSample;
        const rgb = color.length === 1 ? [color[0]!, color[0]!, color[0]!] : color;
        const at = ((pass.y + row * pass.dy) * header.width + pass.x + column * pass.dx) * 8;
        for (const [index, sample] of [...rgb, alpha].entries()) {
          decoded.writeUInt16BE(Math.round((sample * 65535) / maximum), at + index * 2);
        }
        if (alpha > 0) visiblePixelCount += 1;
        // RGB hidden behind zero alpha has no visible content, however many
        // different byte values the encoder leaves in those channels.
        if (seen.size < 2) seen.add(alpha === 0 ? "transparent" : `${color.join(",")}/${alpha}`);
      }
    }
  }
  if (visiblePixelCount === 0)
    throw new Error(`${where} decodes to no visible pixels; the render is fully transparent`);
  if (seen.size < 2) {
    throw new Error(
      `${where} decodes to a single flat colour across all ${header.width}x${header.height} pixels: the canvas was painted but no feature was drawn on it, which is what a style/render no-op produces`,
    );
  }

  // Checked last, so a structurally explicable artifact is diagnosed by its
  // structure and only a well-formed but implausibly small render falls through
  // to the size floor.
  if (bytes.length < expected.minByteLength) {
    throw new Error(
      `${where} is ${bytes.length} bytes; a drawn ${expected.width}x${expected.height} map is at least ` +
        `${expected.minByteLength}. An empty raster of the right dimensions is what a style/render no-op returns.`,
    );
  }

  return {
    uri: expected.uri,
    mediaType: expected.mediaType,
    width: header.width,
    height: header.height,
    byteLength: bytes.length,
    imageSha256: createHash("sha256").update(bytes).digest("hex"),
    visiblePixelCount,
    decodedPixelSha256: createHash("sha256").update(decoded).digest("hex"),
  };
}
