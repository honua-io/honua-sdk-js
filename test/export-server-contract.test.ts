import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { openExport, publicationSource, verifyPmtilesArtifact } from "../src/export/index.js";
import { serveExport } from "./helpers/export-fixture.js";
import { nodeDriver } from "./helpers/publication-fixture.js";

// An Export as honua-server writes it: flat capture keys in both files, `integer`/`number` table types
// and the server's `honua:` extension URI. The three files are kept exactly as the server produced them.
const DIRECTORY = fileURLToPath(new URL("./fixtures/export/honua-server-v1/", import.meta.url));
const EXPORT_ID = "scol2636-x2636-6c79f78d";
const COLLECTION = JSON.parse(readFileSync(path.join(DIRECTORY, "collection.json"), "utf8")) as Record<string, unknown>;

const FILES = {
  prefix: `/exports/${EXPORT_ID}/20261123T141255Z-d24e032d`,
  directory: DIRECTORY,
  artifacts: [`${EXPORT_ID}.parquet`, `${EXPORT_ID}.pmtiles`],
};

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((entry) => entry.close()));
});

async function serve(collection: Record<string, unknown> = COLLECTION) {
  const host = await serveExport(collection, { head: false, files: FILES });
  open.push(host);
  return host;
}

describe("an Export written by honua-server", () => {
  it("opens with every public field, numeric ones included", async () => {
    const { server, url } = await serve();
    const opened = await openExport(url);
    const publication = opened.publication!;

    expect(opened.display).toMatchObject({
      pmtilesUrl: `${server.origin}${FILES.prefix}/${EXPORT_ID}.pmtiles`,
      sourceLayer: "layer",
      promoteId: "parcel_id",
    });
    expect(publication.publicFields.map((field) => [field.name, field.type])).toEqual([
      ["objectid", "integer"],
      ["id", "integer"],
      ["parcel_id", "string"],
      ["zone", "string"],
      ["acres", "number"],
      ["owner_note", "string"],
    ]);
    await verifyPmtilesArtifact(publication);
  });

  it("resolves an identity from its GeoParquet on a host that refuses HEAD", async () => {
    const { server, url } = await serve();
    const source = publicationSource((await openExport(url)).publication!, { driverFactory: nodeDriver });

    const { result, answeredBy } = await source.lookup("P203");

    expect(answeredBy).toBe("geoparquet");
    expect(result.features[0]?.attributes).toMatchObject({ parcel_id: "P203", zone: "C1", acres: 2.3 });
    expect(server.requests.some((entry) => entry.method === "HEAD")).toBe(false);
  });

  it("still refuses files from another capture", async () => {
    const { url } = await serve({ ...COLLECTION, "honua:capture_id": "capture-other" });
    const source = publicationSource((await openExport(url)).publication!, { driverFactory: nodeDriver });
    await expect(source.lookup("P203")).rejects.toMatchObject({ code: "artifact-mismatch" });
  });
});
