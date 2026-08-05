// Generated from examples/react-quickstart by scripts/sample-playgrounds.mjs.
// The repository build aliases @honua/sdk-js onto src/; a playground resolves
// the published package from node_modules instead, so no alias is needed.
//
// examples/react-quickstart reads its data from a Node fixture server the repository
// runs beside it; a browser playground has no such process. This config answers
// the same routes from the project's own dev and preview server, so the default
// lane needs no account, no key, and no third-party request. Every document
// under fixtures/ is a byte-identical copy of samples/fixtures/first-map/v1;
// npm run samples:playgrounds:check fails the moment either drifts.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { type Plugin, defineConfig } from "vite";

/** Same-origin path -> committed fixture document answering it. */
const FIXTURE_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["/api/v1/admin/capabilities", "capabilities.json"],
  ["/rest/services/natural-earth/FeatureServer/0/query", "features.json"],
];

function fixtureDocument(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

function honuaFixtureService(): Plugin {
  const documents = new Map(FIXTURE_ROUTES.map(([route, name]) => [route, fixtureDocument(name)]));
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    // Path-only matching: the SDK's adapters append their own query strings,
    // exactly as the sample's repository fixture server assumes.
    const body = documents.get(new URL(request.url ?? "/", "http://localhost").pathname);
    if (body === undefined) {
      next();
      return;
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(body);
  };
  return {
    name: "honua-fixture-service",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [honuaFixtureService()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
