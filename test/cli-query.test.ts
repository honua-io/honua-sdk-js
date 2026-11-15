import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryCommand } from "../src/cli/commands/query.js";

const context = { baseUrl: "https://maps.test" };
let output: string[];
let requests: URL[];

function respond(body: unknown): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requests.push(new URL(String(input)));
    return Response.json(body);
  });
}

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

describe("CLI spatial counts", () => {
  it("uses the same spatial filter for counts and feature queries", async () => {
    respond({ features: [], count: 0 });
    const flags = { bbox: "0,0,1,1", where: "population > 0" };
    await queryCommand({ positionals: ["places/0"], flags }, context);
    await queryCommand({ positionals: ["places/0"], flags: { ...flags, count: true, json: true } }, context);
    const params = requests.map((request) => request.searchParams);
    for (const key of ["geometry", "geometryType", "spatialRel", "where"]) {
      expect(params[1]?.get(key)).toBe(params[0]?.get(key));
    }
    expect(JSON.parse(params[1]?.get("geometry") ?? "null")).toEqual({
      xmin: 0, ymin: 0, xmax: 1, ymax: 1, spatialReference: { wkid: 4326 },
    });
    expect(params[1]?.get("returnCountOnly")).toBe("true");
    expect(params[1]?.get("returnGeometry")).toBe("false");
    expect(JSON.parse(output.at(-1) ?? "")).toMatchObject({ count: 0 });
  });

  it.each(["not-a-bbox", "0,0,1", "0,0,no,1"])(
    "rejects invalid count bbox %s before network access", async (bbox) => {
      respond({ count: 3 });
      await expect(queryCommand({ positionals: ["places/0"], flags: { bbox, count: true } }, context))
        .rejects.toThrow();
      expect(requests).toHaveLength(0);
    },
  );

  it("preserves unfiltered counts without a bbox", async () => {
    respond({ count: 3 });
    await queryCommand({ positionals: ["places/0"], flags: { count: true } }, context);
    expect(requests[0]?.searchParams.has("geometry")).toBe(false);
    expect(output.join("").trim()).toBe("3");
  });
});

