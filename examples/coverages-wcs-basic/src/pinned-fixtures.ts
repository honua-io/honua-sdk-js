const landing = {
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
  properties: { elevation: { title: "Elevation", type: "number", "x-ogc-nodata": [-9999] } },
};
const wcsCapabilities = `<?xml version="1.0" encoding="UTF-8"?>
<wcs:Capabilities version="2.0.1" xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:ows="http://www.opengis.net/ows/2.0">
  <ows:ServiceIdentification><ows:Title>Honua WCS fixture</ows:Title></ows:ServiceIdentification>
  <ows:OperationsMetadata>
    <ows:Operation name="GetCapabilities" />
    <ows:Operation name="DescribeCoverage" />
    <ows:Operation name="GetCoverage" />
  </ows:OperationsMetadata>
  <wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>7</wcs:CoverageId></wcs:CoverageSummary></wcs:Contents>
</wcs:Capabilities>`;
const wcsDescription = `<?xml version="1.0" encoding="UTF-8"?>
<wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">
  <wcs:CoverageDescription>
    <wcs:CoverageId>7</wcs:CoverageId>
    <gml:boundedBy><gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/4326" axisLabels="Lat Long"><gml:lowerCorner>21.2 -158.3</gml:lowerCorner><gml:upperCorner>21.75 -157.6</gml:upperCorner></gml:Envelope></gml:boundedBy>
  </wcs:CoverageDescription>
</wcs:CoverageDescriptions>`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAAkHrNwAAAABJRU5ErkJggg==";

export const fixtureFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.pathname.endsWith("/wcs")) {
    const operation = url.searchParams.get("REQUEST");
    if (operation === "GetCapabilities") return xml(wcsCapabilities);
    if (operation === "DescribeCoverage") return xml(wcsDescription);
  }
  if (url.pathname.endsWith("/schema")) return json(schema);
  if (url.pathname.endsWith("/coverage")) {
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } });
  }
  if (url.pathname.endsWith("/collections/7")) return json(landing);
  return new Response("Pinned fixture route not found", { status: 404 });
};

function json(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, { headers: { "Content-Type": "application/json", "Content-Length": String(body.length) } });
}

function xml(value: string): Response {
  return new Response(value, {
    headers: { "Content-Type": "application/xml", "Content-Length": String(new TextEncoder().encode(value).length) },
  });
}
