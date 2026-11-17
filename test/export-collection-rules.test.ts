import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  COG_MEDIA_TYPE,
  HonuaPublicationError,
  exportFromCollection,
  openExport,
  publicationSource,
} from "../src/export/index.js";
import { mauiExportCollection, serveExport } from "./helpers/export-fixture.js";
import { nodeDriver } from "./helpers/publication-fixture.js";

const PORTOLAN_EXAMPLE = JSON.parse(
  readFileSync(new URL("./fixtures/export/portolan-v0.3.0/vector-collection.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const URL_BASE = "https://data.example.org/exports/collection.json";
const MAUI = mauiExportCollection();
const MAUI_ASSETS = MAUI.assets as Record<string, Record<string, unknown>>;

const hosts: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

function failurePath(document: unknown): unknown {
  try {
    exportFromCollection(document, URL_BASE);
  } catch (error) {
    expect(error).toBeInstanceOf(HonuaPublicationError);
    return (error as HonuaPublicationError).detail?.path;
  }
  return undefined;
}

describe("Export collection leniency", () => {
  it("ignores assets it does not read, which may omit type and roles", () => {
    const assets = { ...(PORTOLAN_EXAMPLE.assets as object), readme: { href: "README.md" } };
    expect(exportFromCollection({ ...PORTOLAN_EXAMPLE, assets }, URL_BASE).collection.data.key).toBe("data");
  });

  it("accepts a three-dimensional extent", () => {
    const extent = { spatial: { bbox: [[-7.5, 35.9, -10, -1.6, 38.7, 3000]] } };
    expect(exportFromCollection({ ...PORTOLAN_EXAMPLE, extent }, URL_BASE).collection.bounds).toEqual([
      -7.5, 35.9, -1.6, 38.7,
    ]);
  });

  it("opens a raster archive linked without vector layers, with no query source", () => {
    const raster = {
      ...PORTOLAN_EXAMPLE,
      assets: { data: { href: "./scene.tif", type: COG_MEDIA_TYPE, roles: ["data"] } },
      links: [{ rel: "pmtiles", href: "./scene.pmtiles", type: "application/vnd.pmtiles" }],
    };
    const opened = exportFromCollection(raster, URL_BASE);
    expect(opened.renderPath).toBe("visual");
    expect(opened.display?.sourceLayer).toBeUndefined();
    expect(opened.sourceDescriptors().query).toBeUndefined();
  });

  it("refuses hrefs that are not http(s)", () => {
    const assets = { ...MAUI_ASSETS, data: { ...MAUI_ASSETS.data, href: "file:///etc/passwd" } };
    expect(failurePath({ ...MAUI, assets })).toBe("assets.data.href");
  });
});

describe("Honua Export paired view prerequisites", () => {
  it("builds the paired view from the rel pmtiles link alone", () => {
    const { visual: _visual, ...assets } = MAUI_ASSETS;
    const opened = exportFromCollection({ ...MAUI, assets }, URL_BASE);
    expect(opened.publication?.display).toMatchObject({ sourceLayer: "parcels", promoteId: "tmk_txt" });
  });

  it("has no paired view without a version, rather than guessing the stamp", () => {
    const { version: _version, ...unversioned } = MAUI;
    const opened = exportFromCollection(unversioned, URL_BASE);
    expect(opened.publication).toBeUndefined();
    expect(opened.sourceDescriptors().query).toBeUndefined();
  });

  it("refuses an identity column that is not text", () => {
    const columns = (MAUI["table:columns"] as Array<Record<string, string>>).map((column) =>
      column.name === "tmk_txt" ? { ...column, type: "int64" } : column,
    );
    expect(failurePath({ ...MAUI, "table:columns": columns })).toBe("honua:identity.field");
  });

  it("refuses queries that name a column outside the public fields", async () => {
    const host = await serveExport(MAUI);
    hosts.push(host);
    const source = publicationSource((await openExport(host.url)).publication!, { driverFactory: nodeDriver });
    await expect(source.query({ outFields: ["internal_note"] })).rejects.toMatchObject({ code: "non-public-field" });
  });
});
