import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tilesCommand } from "../src/cli/commands/map.js";

const context = { baseUrl: "https://maps.test" };
let output: string[];
let requests: URL[];

beforeEach(() => {
  output = [];
  requests = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function tileUrl(flags: Record<string, string | boolean>): Promise<string> {
  await tilesCommand({ positionals: ["maui-parcels", "12/267/1805"], flags: { json: true, ...flags } }, context);
  return JSON.parse(output.at(-1) ?? "{}").url;
}

describe("CLI tiles", () => {
  it("reads the service's cached map tile by default", async () => {
    expect(await tileUrl({})).toBe("https://maps.test/rest/services/maui-parcels/MapServer/tile/12/1805/267");
  });

  it("reads the image service tile cache with --image", async () => {
    expect(await tileUrl({ image: true, format: "jpg" })).toBe(
      "https://maps.test/rest/services/maui-parcels/ImageServer/tile/12/1805/267?f=jpg",
    );
  });

  it("rejects --format without --image instead of ignoring it", async () => {
    await expect(tileUrl({ format: "jpg" })).rejects.toThrow(/--image/);
  });

  it("saves the map tile bytes with -o", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requests.push(new URL(String(input)));
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    });
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "honua-tiles-")), "tile.png");
    await tilesCommand({ positionals: ["maui-parcels", "12/267/1805"], flags: { output: out } }, context);
    expect(requests.map((url) => url.pathname)).toEqual(["/rest/services/maui-parcels/MapServer/tile/12/1805/267"]);
    expect(fs.readFileSync(out)).toHaveLength(4);
  });
});
