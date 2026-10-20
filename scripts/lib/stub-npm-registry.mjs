// Loopback stand-in for the npm registry's package metadata endpoint, so the
// create-honua-app gates can prove which SDK version a scaffold pins for a
// given channel state without reading the real registry.

import http from "node:http";

/**
 * Serve `GET /<name>` (scoped names arrive as `@scope%2fname`) from
 * `packuments`, a map of package name to `{ "dist-tags", versions }`. Every
 * other path is a 404. Resolves to `{ url, requests, close }`.
 */
export async function startStubRegistry(packuments) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, "http://registry.invalid").pathname.slice(1));
    requests.push(name);
    const packument = packuments[name];
    if (request.method !== "GET" || !packument) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"Not found"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name, ...packument }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Registry metadata for `versions` with the given dist-tags. */
export function packument(distTags, versions) {
  return { "dist-tags": distTags, versions: Object.fromEntries(versions.map((version) => [version, { version }])) };
}
