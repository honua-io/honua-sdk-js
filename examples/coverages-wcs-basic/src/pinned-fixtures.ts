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
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAAkHrNwAAAABJRU5ErkJggg==";

export const fixtureFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
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
