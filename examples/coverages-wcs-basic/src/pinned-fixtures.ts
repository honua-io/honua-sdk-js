export const FIXTURE_ORIGIN = "https://coverages.fixture.invalid";
export const FIXTURE_VERSION = "oahu-elevation-v2 / 64 x 48 PNG / 494 bytes";
export const CENTER_PIXEL = { coordinate: [-158, 21.4] as const, value: 412, unit: "m" };

export interface FixtureRequestEvidence {
  readonly protocol: "ogc-coverages" | "wcs";
  readonly operation: string;
  readonly url: string;
}

export const fixtureRequestLog: FixtureRequestEvidence[] = [];

const landing = {
  title: "Honua island elevation coverages",
  description: "Pinned coverage fixture for browser qualification.",
  links: [],
};
const collection = {
  id: "7",
  title: "Oahu elevation",
  itemType: "coverage",
  storageCrs: "http://www.opengis.net/def/crs/EPSG/0/4326",
  extent: { spatial: { bbox: [[-158.3, 21.2, -157.6, 21.75]] } },
  grid: { axisLabels: ["Lat", "Long"] },
  domain: { axes: { Lat: { lower: 21.2, upper: 21.75 }, Long: { lower: -158.3, upper: -157.6 } } },
  links: [],
};
const schema = {
  type: "object",
  properties: {
    elevation: { title: "Elevation", type: "number", "x-ogc-nodata": [-9999] },
    quality: { title: "Quality mask", type: "integer", "x-ogc-nodata": [255] },
  },
};
const wcsCapabilities = `<?xml version="1.0" encoding="UTF-8"?>
<wcs:Capabilities version="2.0.1" xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:ows="http://www.opengis.net/ows/2.0">
  <ows:ServiceIdentification><ows:Title>Honua WCS fixture</ows:Title></ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetCapabilities" />
    <ows:Operation name="DescribeCoverage" />
    <ows:Operation name="GetCoverage" />
  </ows:OperationsMetadata>
  <wcs:ServiceMetadata><wcs:formatSupported>image/png</wcs:formatSupported></wcs:ServiceMetadata>
  <wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>7</wcs:CoverageId></wcs:CoverageSummary></wcs:Contents>
</wcs:Capabilities>`;
const wcsDescription = `<?xml version="1.0" encoding="UTF-8"?>
<wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:gmlcov="http://www.opengis.net/gmlcov/1.0" xmlns:swe="http://www.opengis.net/swe/2.0">
  <wcs:CoverageDescription>
    <wcs:CoverageId>7</wcs:CoverageId>
    <gml:boundedBy><gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/4326" axisLabels="Lat Long"><gml:lowerCorner>21.2 -158.3</gml:lowerCorner><gml:upperCorner>21.75 -157.6</gml:upperCorner></gml:Envelope></gml:boundedBy>
    <gmlcov:rangeType><swe:DataRecord>
      <swe:field name="elevation"><swe:Quantity><swe:label>Elevation</swe:label><swe:nilValues><swe:NilValues><swe:nilValue reason="http://www.opengis.net/def/nil/OGC/0/missing">-9999</swe:nilValue></swe:NilValues></swe:nilValues></swe:Quantity></swe:field>
      <swe:field name="quality"><swe:Count><swe:label>Quality mask</swe:label><swe:nilValues><swe:NilValues><swe:nilValue reason="http://www.opengis.net/def/nil/OGC/0/missing">255</swe:nilValue></swe:NilValues></swe:nilValues></swe:Count></swe:field>
    </swe:DataRecord></gmlcov:rangeType>
  </wcs:CoverageDescription>
</wcs:CoverageDescriptions>`;
const invalidBandException = `<?xml version="1.0" encoding="UTF-8"?>
<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/2.0" version="2.0.1">
  <ows:Exception exceptionCode="InvalidParameterValue" locator="RANGESUBSET">
    <ows:ExceptionText>The requested range field is not advertised.</ows:ExceptionText>
  </ows:Exception>
</ows:ExceptionReport>`;
const coveragePng =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAChS3wfAAABtUlEQVR42uWasVEEMQxFVQMdUMoNHTDE1EB8rdADGeUQ0MC1AONgN1gby5Leek44+KnX70kz8sxKHi5PP608vr12c31/GYp2jvcbXx/PVW7fn838xVgiVvhR8KgI7bxRAT14swAvvFUGBa8JKN+S2fBEiOpvXOkEkPCVgIzwVgFHNlmp9Vt8XQH3Do8JWLH1VQGRi5WcDW8R0Bu5Qs5iWgQB7xJAgEdFaOcR1TcL8MJbZVDwI896mQ1PhKj+xpVOAAlfCcgIbxVwZJOVWr/F1xVw7/CYgBVbXxUQuVjJ2fAWAb2RK+QspkUQ8C4BBHhUhHYeUX2zAC+8VQYFP/Ksl9nwRIjqb1zpBJDwlYCM8FYBRzZZqfVbfOL52fBfqr8LWLH1VQGRi5WcDW8R0Bu5Qs5iWgQB7xJAgEdFaOcR1TcL8MJbZVDwI896mQ1PhKj+xpVOAAlfCcgIbxVwZJOVWr/FJ5H9muzV3wWs2PqqgMjFSs6GtwjojVwhZzEtgoB3CSDAoyI8q3SeJ71Qf1pJGRT8yLNeZsMTIaq/b4pmE0DCVwIywkdXZ2Wl1m8uS0f2a7JXv+QX0dGkp6SwOrEAAAAASUVORK5CYII=";

export const fixtureFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== FIXTURE_ORIGIN) {
    throw new TypeError(`Pinned coverage fixture blocked an unexpected origin: ${url.origin}`);
  }

  const wcsOperation = url.searchParams.get("REQUEST");
  fixtureRequestLog.push({
    protocol: url.pathname.endsWith("/wcs") ? "wcs" : "ogc-coverages",
    operation: wcsOperation ?? ogcOperation(url.pathname),
    url: url.href,
  });

  if (url.pathname.endsWith("/wcs")) {
    if (wcsOperation === "GetCapabilities") return xml(wcsCapabilities);
    if (wcsOperation === "DescribeCoverage") return xml(wcsDescription);
    if (wcsOperation === "GetCoverage") {
      if (url.searchParams.get("RANGESUBSET") === "not-a-band") return xml(invalidBandException, 400);
      return png();
    }
  }
  if (url.pathname === "/ogc/coverages") return json(landing);
  if (url.pathname === "/ogc/coverages/conformance") return json({ conformsTo: [], links: [] });
  if (url.pathname === "/ogc/coverages/collections") return json({ collections: [collection], links: [] });
  if (url.pathname.endsWith("/schema")) return json(schema);
  if (url.pathname.endsWith("/coverage")) {
    if (url.searchParams.get("properties") === "quality") await abortableDelay(250, request.signal);
    return png();
  }
  if (url.pathname.endsWith("/collections/7")) return json(collection);
  return new Response("Pinned fixture route not found", { status: 404 });
};

function ogcOperation(pathname: string): string {
  if (pathname.endsWith("/coverage")) return "GetCoverage";
  if (pathname.endsWith("/schema")) return "RangeType";
  if (pathname.endsWith("/collections")) return "Collections";
  if (pathname.endsWith("/collections/7")) return "Collection";
  if (pathname.endsWith("/conformance")) return "Conformance";
  return "Landing";
}

function png(): Response {
  const bytes = Uint8Array.from(atob(coveragePng), (character) => character.charCodeAt(0));
  return new Response(bytes, {
    headers: { "Content-Type": "image/png", "Content-Length": String(bytes.byteLength) },
  });
}

function json(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(body).length) },
  });
}

function xml(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "Content-Type": "application/xml", "Content-Length": String(new TextEncoder().encode(value).length) },
  });
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Pinned coverage request aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Pinned coverage request aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
