const encoder = new TextEncoder();

export const FIXTURE_ORIGIN = "https://coverages.fixture.invalid";

export const COVERAGE_FIXTURE_CONTRACT = {
  collectionId: "7",
  coverageId: "7",
  bbox: [-158.1, 21.3, -157.9, 21.5] as const,
  bboxCrs: "EPSG:4326",
  wcsCrs: "http://www.opengis.net/def/crs/EPSG/0/4326",
  axes: { latitude: "Lat", longitude: "Long" } as const,
  band: "elevation",
  cancellationBand: "quality",
  degradationBand: "not-a-band",
  width: 320,
  height: 220,
  cancellationSize: 64,
  format: "image/png",
  maxResponseBytes: 1024 * 1024,
} as const;

export const ELEVATION_LEGEND = [
  { value: 0, color: [18, 65, 67] as const },
  { value: 150, color: [33, 112, 94] as const },
  { value: 300, color: [122, 155, 84] as const },
  { value: 450, color: [221, 174, 82] as const },
  { value: 600, color: [238, 225, 181] as const },
] as const;

export const FIXTURE_IMAGE_SHA256 = "8c7b5b3f8bd31bca2df07c4a70254d75e70d63838c2f77e033def3c1b8d2acff";
export const FIXTURE_IMAGE_BYTE_LENGTH = 281_908;
export const FIXTURE_VERSION = `oahu-elevation-v3 / ${COVERAGE_FIXTURE_CONTRACT.width} x ${COVERAGE_FIXTURE_CONTRACT.height} deterministic PNG / ${FIXTURE_IMAGE_BYTE_LENGTH} bytes / sha256:${FIXTURE_IMAGE_SHA256}`;

export interface FixtureRequestEvidence {
  readonly protocol: "ogc-coverages" | "wcs";
  readonly operation: string;
  readonly url: string;
}

export const fixtureRequestLog: FixtureRequestEvidence[] = [];

const collection = {
  id: COVERAGE_FIXTURE_CONTRACT.collectionId,
  title: "Oahu elevation",
  itemType: "coverage",
  storageCrs: COVERAGE_FIXTURE_CONTRACT.wcsCrs,
  extent: { spatial: { bbox: [[-158.3, 21.2, -157.6, 21.75]] } },
  grid: { axisLabels: ["Lat", "Long"] },
  domain: {
    axes: {
      Lat: { lower: 21.2, upper: 21.75 },
      Long: { lower: -158.3, upper: -157.6 },
    },
  },
  links: [],
};

const schema = {
  type: "object",
  properties: {
    elevation: { title: "Elevation", type: "number", "x-ogc-nodata": [-9999] },
    quality: { title: "Quality mask", type: "integer", "x-ogc-nodata": [255] },
  },
};

const capabilitiesXml = `<?xml version="1.0" encoding="UTF-8"?>
<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:ows="http://www.opengis.net/ows/2.0" version="2.0.1">
  <ows:ServiceIdentification><ows:Title>Honua WCS fixture</ows:Title></ows:ServiceIdentification>
  <ows:OperationsMetadata><ows:Operation name="GetCapabilities"/><ows:Operation name="DescribeCoverage"/><ows:Operation name="GetCoverage"/></ows:OperationsMetadata>
  <wcs:ServiceMetadata><wcs:formatSupported>image/png</wcs:formatSupported></wcs:ServiceMetadata>
  <wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>${COVERAGE_FIXTURE_CONTRACT.coverageId}</wcs:CoverageId></wcs:CoverageSummary></wcs:Contents>
</wcs:Capabilities>`;

const describeCoverageXml = `<?xml version="1.0" encoding="UTF-8"?>
<wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:gmlcov="http://www.opengis.net/gmlcov/1.0" xmlns:swe="http://www.opengis.net/swe/2.0">
  <wcs:CoverageDescription><wcs:CoverageId>${COVERAGE_FIXTURE_CONTRACT.coverageId}</wcs:CoverageId><gml:boundedBy><gml:Envelope srsName="${COVERAGE_FIXTURE_CONTRACT.wcsCrs}" axisLabels="Lat Long"><gml:lowerCorner>21.2 -158.3</gml:lowerCorner><gml:upperCorner>21.75 -157.6</gml:upperCorner></gml:Envelope></gml:boundedBy><gmlcov:rangeType><swe:DataRecord><swe:field name="elevation"><swe:Quantity><swe:label>Elevation</swe:label><swe:nilValues><swe:NilValues><swe:nilValue reason="http://www.opengis.net/def/nil/OGC/0/missing">-9999</swe:nilValue></swe:NilValues></swe:nilValues></swe:Quantity></swe:field><swe:field name="quality"><swe:Count><swe:label>Quality mask</swe:label><swe:nilValues><swe:NilValues><swe:nilValue reason="http://www.opengis.net/def/nil/OGC/0/missing">255</swe:nilValue></swe:NilValues></swe:nilValues></swe:Count></swe:field></swe:DataRecord></gmlcov:rangeType></wcs:CoverageDescription>
</wcs:CoverageDescriptions>`;

function u32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(type);
  const body = concat(typeBytes, data);
  return concat(u32(data.length), body, u32(crc32(body)));
}

function deflateStored(bytes: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let offset = 0; offset < bytes.length; offset += 65535) {
    const length = Math.min(65535, bytes.length - offset);
    const complement = ~length & 0xffff;
    blocks.push(
      Uint8Array.of(
        offset + length === bytes.length ? 1 : 0,
        length & 0xff,
        length >>> 8,
        complement & 0xff,
        complement >>> 8,
      ),
      bytes.slice(offset, offset + length),
    );
  }
  blocks.push(u32(adler32(bytes)));
  return concat(...blocks);
}

function legendIndex(x: number, y: number): number {
  const terrain =
    (x / (COVERAGE_FIXTURE_CONTRACT.width - 1)) * 2.4 +
    ((COVERAGE_FIXTURE_CONTRACT.height - 1 - y) / (COVERAGE_FIXTURE_CONTRACT.height - 1)) * 1.4 +
    ((Math.sin(x / 21) + 1) * 0.35 + 0.5);
  return Math.max(0, Math.min(ELEVATION_LEGEND.length - 1, Math.floor(terrain)));
}

export function createPinnedCoveragePng(): Uint8Array {
  const { width, height } = COVERAGE_FIXTURE_CONTRACT;
  const scanlines = new Uint8Array(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    scanlines[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = ELEVATION_LEGEND[legendIndex(x, y)].color;
      scanlines[offset++] = red;
      scanlines[offset++] = green;
      scanlines[offset++] = blue;
      scanlines[offset++] = 255;
    }
  }

  const ihdr = concat(u32(width), u32(height), Uint8Array.of(8, 6, 0, 0, 0));
  return concat(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateStored(scanlines)),
    chunk("IEND", new Uint8Array()),
  );
}

const imageBytes = createPinnedCoveragePng();
let verifiedImage: Promise<void> | undefined;

async function verifyPinnedImage(): Promise<void> {
  verifiedImage ??= (async () => {
    if (imageBytes.byteLength !== FIXTURE_IMAGE_BYTE_LENGTH) {
      throw new Error(`Pinned coverage fixture byte length drifted: ${imageBytes.byteLength}`);
    }
    const digest = await crypto.subtle.digest("SHA-256", imageBytes.slice().buffer);
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== FIXTURE_IMAGE_SHA256) {
      throw new Error(`Pinned coverage fixture digest drifted: ${actual}`);
    }
  })();
  return verifiedImage;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

function fail(request: Request, reason: string): never {
  throw new TypeError(`Pinned coverage fixture rejected ${request.method} ${request.url}: ${reason}`);
}

function assertHeader(request: Request, expected: string): void {
  const actual = request.headers.get("accept") ?? "";
  if (actual !== expected) fail(request, `Accept must equal ${expected}, received ${actual || "<missing>"}`);
}

function assertQuery(request: Request, url: URL, expected: readonly (readonly [string, string])[]): void {
  const compare = (left: readonly [string, string], right: readonly [string, string]) =>
    left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]);
  const actual = [...url.searchParams.entries()].sort(compare);
  const normalizedExpected = [...expected].sort(compare);
  if (
    actual.length !== normalizedExpected.length ||
    actual.some(
      ([key, value], index) => key !== normalizedExpected[index]?.[0] || value !== normalizedExpected[index]?.[1],
    )
  ) {
    fail(request, `query must equal ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertNoQuery(request: Request, url: URL): void {
  assertQuery(request, url, []);
}

function pngResponse(): Response {
  if (imageBytes.byteLength > COVERAGE_FIXTURE_CONTRACT.maxResponseBytes) {
    throw new Error("Pinned image exceeds the configured response ceiling");
  }
  return new Response(imageBytes.slice(), {
    headers: {
      "content-type": COVERAGE_FIXTURE_CONTRACT.format,
      "content-length": String(imageBytes.byteLength),
      "x-fixture-sha256": FIXTURE_IMAGE_SHA256,
    },
  });
}

function wcsBase(requestName: string): readonly (readonly [string, string])[] {
  return [
    ["SERVICE", "WCS"],
    ["VERSION", "2.0.1"],
    ["REQUEST", requestName],
  ];
}

function wcsCoverageQuery(band: string, size: number): readonly (readonly [string, string])[] {
  const { axes, bbox, coverageId, format, wcsCrs } = COVERAGE_FIXTURE_CONTRACT;
  return [
    ...wcsBase("GetCoverage"),
    ["COVERAGEID", coverageId],
    ["SUBSET", `${axes.latitude}(${bbox[1]},${bbox[3]})`],
    ["SUBSET", `${axes.longitude}(${bbox[0]},${bbox[2]})`],
    ["SUBSETTINGCRS", wcsCrs],
    ["OUTPUTCRS", wcsCrs],
    ["RANGESUBSET", band],
    [
      "SCALESIZE",
      `${axes.latitude}(${size === COVERAGE_FIXTURE_CONTRACT.height ? COVERAGE_FIXTURE_CONTRACT.height : size}),${axes.longitude}(${size === COVERAGE_FIXTURE_CONTRACT.height ? COVERAGE_FIXTURE_CONTRACT.width : size})`,
    ],
    ["FORMAT", format],
  ];
}

function recordFixtureRequest(url: URL): void {
  fixtureRequestLog.push({
    protocol: url.pathname.endsWith("/wcs") ? "wcs" : "ogc-coverages",
    operation:
      url.searchParams.get("REQUEST") ??
      (url.pathname.endsWith("/coverage")
        ? "GetCoverage"
        : url.pathname.endsWith("/schema")
          ? "RangeType"
          : url.pathname.endsWith("/collections")
            ? "Collections"
            : "Collection"),
    url: url.toString(),
  });
}

async function delayedAbortable(request: Request): Promise<Response> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 80);
    request.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Pinned coverage request aborted", "AbortError"));
      },
      { once: true },
    );
  });
  return pngResponse();
}

export function createPinnedFixtureFetch(options: { readonly maxResponseBytes: number }): typeof fetch {
  if (options.maxResponseBytes !== COVERAGE_FIXTURE_CONTRACT.maxResponseBytes) {
    throw new TypeError(
      `Pinned coverage fixture rejected response ceiling ${options.maxResponseBytes}; expected ${COVERAGE_FIXTURE_CONTRACT.maxResponseBytes}`,
    );
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const {
      band,
      bbox,
      bboxCrs,
      cancellationBand,
      cancellationSize,
      collectionId,
      coverageId,
      degradationBand,
      format,
      height,
      width,
    } = COVERAGE_FIXTURE_CONTRACT;

    if (request.method !== "GET") fail(request, "only GET is allowed");
    if (url.origin !== FIXTURE_ORIGIN) fail(request, `origin must equal ${FIXTURE_ORIGIN}`);

    let response: Response;
    if (url.pathname === "/ogc/coverages/collections") {
      assertNoQuery(request, url);
      assertHeader(request, "application/json");
      recordFixtureRequest(url);
      response = json({ collections: [collection], links: [] });
    } else if (url.pathname === `/ogc/coverages/collections/${collectionId}`) {
      assertNoQuery(request, url);
      assertHeader(request, "application/json");
      recordFixtureRequest(url);
      response = json(collection);
    } else if (url.pathname === `/ogc/coverages/collections/${collectionId}/schema`) {
      assertNoQuery(request, url);
      assertHeader(request, "application/json");
      recordFixtureRequest(url);
      response = json(schema);
    } else if (url.pathname === `/ogc/coverages/collections/${collectionId}/coverage`) {
      assertHeader(request, format);
      const primary = [
        ["bbox", bbox.join(",")],
        ["bbox-crs", bboxCrs],
        ["crs", bboxCrs],
        ["properties", band],
        ["scale-size", `x(${width}),y(${height})`],
        ["f", "png"],
      ] as const;
      const cancellation = [
        ["bbox", bbox.join(",")],
        ["bbox-crs", bboxCrs],
        ["crs", bboxCrs],
        ["properties", cancellationBand],
        ["scale-size", `x(${cancellationSize}),y(${cancellationSize})`],
        ["f", "png"],
      ] as const;
      const degradation = [
        ["bbox", bbox.join(",")],
        ["bbox-crs", bboxCrs],
        ["crs", bboxCrs],
        ["properties", degradationBand],
        ["scale-size", `x(${cancellationSize}),y(${cancellationSize})`],
        ["f", "png"],
      ] as const;
      const requestedBand = url.searchParams.get("properties");
      const isCancellation = requestedBand === cancellationBand;
      const isDegradation = requestedBand === degradationBand;
      assertQuery(request, url, isCancellation ? cancellation : isDegradation ? degradation : primary);
      recordFixtureRequest(url);
      if (isDegradation) {
        response = json({ code: "InvalidParameterValue", description: `Unknown property ${degradationBand}` }, 400);
      } else {
        await verifyPinnedImage();
        response = isCancellation ? await delayedAbortable(request) : pngResponse();
      }
    } else if (url.pathname === `/ogc/services/${collectionId}/wcs`) {
      const operation = url.searchParams.get("REQUEST");
      if (operation === "GetCapabilities") {
        assertHeader(request, "application/xml,text/xml;q=0.9");
        assertQuery(request, url, [
          ...wcsBase("GetCapabilities"),
          ["ACCEPTVERSIONS", "2.0.1"],
          ["ACCEPTFORMATS", "application/xml"],
        ]);
        recordFixtureRequest(url);
        response = xml(capabilitiesXml);
      } else if (operation === "DescribeCoverage") {
        assertHeader(request, "application/xml,text/xml;q=0.9");
        assertQuery(request, url, [...wcsBase("DescribeCoverage"), ["COVERAGEID", coverageId]]);
        recordFixtureRequest(url);
        response = xml(describeCoverageXml);
      } else if (operation === "GetCoverage") {
        assertHeader(request, format);
        const requestedBand = url.searchParams.get("RANGESUBSET") ?? "";
        const invalidBand = requestedBand === degradationBand;
        const isCancellation = requestedBand === cancellationBand;
        assertQuery(
          request,
          url,
          wcsCoverageQuery(
            invalidBand ? degradationBand : isCancellation ? cancellationBand : band,
            invalidBand || isCancellation ? cancellationSize : height,
          ),
        );
        recordFixtureRequest(url);
        if (invalidBand) {
          response = xml(
            `<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/2.0" version="2.0.1"><ows:Exception exceptionCode="InvalidParameterValue" locator="RANGESUBSET"><ows:ExceptionText>Unknown range component ${degradationBand}</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`,
            400,
          );
        } else {
          await verifyPinnedImage();
          response = isCancellation ? await delayedAbortable(request) : pngResponse();
        }
      } else {
        fail(request, "unsupported WCS REQUEST");
      }
    } else {
      fail(request, "route, collection ID, or coverage ID is outside the pinned contract");
    }

    return response;
  };
}

export const fixtureFetch = createPinnedFixtureFetch({
  maxResponseBytes: COVERAGE_FIXTURE_CONTRACT.maxResponseBytes,
});
