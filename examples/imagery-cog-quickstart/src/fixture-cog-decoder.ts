import type { CogDecodedMetadata, CogDecoder, CogDecoderFactory, CogWindowRequest } from "@honua/sdk-js/cog";

export interface FixtureCogDecoderTelemetry {
  created(assetUrl: string): void;
  disposed(assetUrl: string): void;
  aborted(assetUrl: string): void;
}

const WGS84_METADATA: CogDecodedMetadata = {
  format: "cog",
  width: 256,
  height: 192,
  crs: { kind: "known", authority: "EPSG", code: "4326", name: "WGS 84" },
  bands: [
    { index: 1, dataType: "uint8", name: "red", colorInterpretation: "red", nodata: 0 },
    { index: 2, dataType: "uint8", name: "green", colorInterpretation: "green", nodata: 0 },
    { index: 3, dataType: "uint8", name: "blue", colorInterpretation: "blue", nodata: 0 },
  ],
  resolution: { x: 0.0021875, y: 0.0022395833333333334, unit: "degree" },
  footprint: {
    type: "Polygon",
    coordinates: [
      [
        [-158.22, 21.21],
        [-157.66, 21.21],
        [-157.66, 21.64],
        [-158.22, 21.64],
        [-158.22, 21.21],
      ],
    ],
  },
  overviewDecimations: [2, 4, 8],
};

function assetKey(assetUrl: string): string {
  return new URL(assetUrl).pathname.split("/").at(-1) ?? "cog";
}

function metadataFor(assetUrl: string): CogDecodedMetadata {
  const key = assetKey(assetUrl);
  if (key === "unsupported-crs") {
    return {
      ...WGS84_METADATA,
      crs: {
        kind: "unsupported",
        description: "EPSG:32604 is intentionally unsupported by this fixture decoder path.",
      },
    };
  }
  if (key === "unsupported-format") return { ...WGS84_METADATA, format: "geotiff" };
  return WGS84_METADATA;
}

function abortError(): DOMException {
  return new DOMException("The COG fixture operation was aborted.", "AbortError");
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function clampByte(value: number): number {
  return Math.max(1, Math.min(255, Math.round(value)));
}

function fixturePixel(assetUrl: string, sourceX: number, sourceY: number): readonly [number, number, number] {
  const normalizedX = (sourceX / WGS84_METADATA.width - 0.5) * 2;
  const normalizedY = (sourceY / WGS84_METADATA.height - 0.5) * 2;
  const rotation = -0.3;
  const along = Math.cos(rotation) * normalizedX - Math.sin(rotation) * normalizedY;
  const across = Math.sin(rotation) * normalizedX + Math.cos(rotation) * normalizedY;
  const coast = (along / 0.86) ** 2 + (across / 0.34) ** 2;
  const eastCape = ((along - 0.66) / 0.28) ** 2 + ((across + 0.02) / 0.18) ** 2;
  const westCape = ((along + 0.69) / 0.24) ** 2 + ((across - 0.03) / 0.2) ** 2;
  const land = Math.min(coast, eastCape, westCape) < 1;
  const texture = Math.sin(sourceX * 0.73 + sourceY * 0.41) * 7 + Math.cos(sourceY * 0.91) * 5;
  const secondScene = assetKey(assetUrl) === "cog-alt";

  if (!land) {
    const shelf = Math.max(0, 1.25 - Math.min(coast, eastCape, westCape));
    return [
      clampByte(22 + shelf * 28 + texture * 0.15),
      clampByte(91 + shelf * 65 + texture * 0.2),
      clampByte((secondScene ? 150 : 164) + shelf * 45 + texture * 0.25),
    ];
  }

  const shoreline = Math.min(coast, eastCape, westCape);
  if (shoreline > 0.83) {
    return [clampByte(210 + texture), clampByte(196 + texture), clampByte(132 + texture * 0.5)];
  }

  const ridgeCenter = 0.06 * Math.sin(along * 7) - 0.03;
  const ridge = Math.exp(-(((across - ridgeCenter) / 0.12) ** 2));
  const urban = along > 0.16 && along < 0.55 && across > 0.04 && across < 0.24;
  if (urban) {
    const streetGrid = (Math.floor(sourceX) + Math.floor(sourceY)) % 4 === 0 ? 24 : 0;
    return [146 + streetGrid, 144 + streetGrid, 134 + streetGrid];
  }
  return [
    clampByte((secondScene ? 66 : 54) + ridge * 22 + texture * 0.35),
    clampByte((secondScene ? 132 : 144) - ridge * 28 + texture * 0.7),
    clampByte((secondScene ? 58 : 67) + ridge * 18 + texture * 0.25),
  ];
}

function bandValues(assetUrl: string, request: CogWindowRequest, band: number): Uint8Array {
  const width = request.sampling?.width ?? request.width;
  const height = request.sampling?.height ?? request.height;
  const values = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const sourceX = request.x + ((x + 0.5) * request.width) / width;
      const sourceY = request.y + ((y + 0.5) * request.height) / height;
      values[index] = fixturePixel(assetUrl, sourceX, sourceY)[band - 1] ?? 255;
    }
  }
  return values;
}

/**
 * Deterministic test decoder. It is imported only after the user chooses a COG
 * candidate; production users inject their own GeoTIFF decoder through the same
 * public SDK boundary.
 */
export function createFixtureCogDecoderFactory(telemetry: FixtureCogDecoderTelemetry): CogDecoderFactory {
  return ({ assetUrl }): CogDecoder => {
    telemetry.created(assetUrl);
    let disposed = false;
    return {
      async inspect({ readRange, signal }) {
        try {
          if (assetKey(assetUrl) === "slow-cog") await pause(450, signal);
          await readRange({ offset: 0, length: 64 });
          await readRange({ offset: 1024, length: 32 });
          return metadataFor(assetUrl);
        } catch (error) {
          if (signal.aborted) telemetry.aborted(assetUrl);
          throw error;
        }
      },
      async readWindow(request, { readRange, signal }) {
        try {
          if (assetKey(assetUrl) === "slow-cog") await pause(250, signal);
          await readRange({ offset: 2048 + request.x + request.y, length: 96 });
          if (signal.aborted) throw abortError();
          const bands = request.bands ?? [1, 2, 3];
          return {
            width: request.sampling?.width ?? request.width,
            height: request.sampling?.height ?? request.height,
            bands: bands.map((band) => ({ band, values: bandValues(assetUrl, request, band) })),
          };
        } catch (error) {
          if (signal.aborted) telemetry.aborted(assetUrl);
          throw error;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        telemetry.disposed(assetUrl);
      },
    };
  };
}
