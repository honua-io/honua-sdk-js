import { afterEach } from "vitest";

import { GeoparquetRuntime } from "../../src/geoparquet/index.js";
import { type RangeServer, fixtureSource, nodeDriver, serveFixture } from "./publication-fixture.js";

export const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function served(overrides: Parameters<typeof serveFixture>[0] = {}): Promise<RangeServer> {
  const server = await serveFixture(overrides);
  cleanups.push(() => server.close());
  return server;
}

export async function pairedSource(server: RangeServer, options: Parameters<typeof fixtureSource>[1] = {}) {
  const runtime = new GeoparquetRuntime({ driverFactory: nodeDriver });
  cleanups.push(() => runtime.dispose());
  return fixtureSource(server, { runtime, ...options });
}
