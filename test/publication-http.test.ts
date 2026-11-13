import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HonuaAbortError } from "../src/core/errors.js";
import { FIXTURE_DIRECTORY, MERGED_MULTIPART_PARCEL, parquetRequests } from "./helpers/publication-fixture.js";
import { pairedSource, served } from "./helpers/publication-test-fixture.js";

const descriptor = JSON.parse(readFileSync(path.join(FIXTURE_DIRECTORY, "descriptor.json"), "utf8"));

describe("HTTP range reads", () => {
  it("reads the GeoParquet artifact only through partial range requests", async () => {
    const server = await served();
    const source = await pairedSource(server);
    await source.lookup(MERGED_MULTIPART_PARCEL);
    const reads = parquetRequests(server).filter((entry) => entry.method === "GET");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.range).toMatch(/^bytes=\d+-\d*$/);
      expect(read.status).toBe(206);
      expect(read.bytes).toBeLessThan(descriptor.artifacts.geoparquet.bytes);
    }
  });

  it("answers a CORS preflight for range requests from another origin", async () => {
    const server = await served();
    const response = await fetch(`${server.origin}/maui/parcels.parquet`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "range",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toMatch(/Range/);
    expect(response.headers.get("access-control-expose-headers")).toMatch(/Content-Range/);
  });

  it("stops issuing range requests once a lookup is cancelled", async () => {
    const server = await served({ delayMs: 150 });
    const source = await pairedSource(server);
    const controller = new AbortController();
    const pending = source.lookup(MERGED_MULTIPART_PARCEL, { signal: controller.signal });
    while (parquetRequests(server).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    const afterCancel = parquetRequests(server).length;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(parquetRequests(server).length).toBeLessThanOrEqual(afterCancel + 1);
  });
});
