import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/main.js";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    restore() {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("honua export CLI", () => {
  it("creates an export with --id and --public and renders deterministic output", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(
          JSON.stringify({
            id: "maui-parcels-public",
            layer: "maui-parcels/1",
            version: "v1",
            visibility: "public",
            status: "ready",
            collectionUrl: "https://data.honua.example/exports/maui-parcels-public/v1/collection.json",
            formats: ["pmtiles", "geoparquet"],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const cap = captureOutput();
    try {
      const code = await run(["export", "maui-parcels/1", "--id", "maui-parcels-public", "--public"], {
        baseUrl: "https://honua.example",
        apiKey: "test-key",
      });
      expect(code).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "https://honua.example/api/v1/admin/exports",
        method: "POST",
      });
      expect(JSON.parse(requests[0]!.body!)).toEqual({
        layer: "maui-parcels/1",
        id: "maui-parcels-public",
        visibility: "public",
        formats: ["pmtiles", "geoparquet"],
      });
      expect(cap.stdout()).toMatchInlineSnapshot(`
        "Export created
        id:             maui-parcels-public
        layer:          maui-parcels/1
        version:        v1
        visibility:     public
        status:         ready
        collectionUrl:  https://data.honua.example/exports/maui-parcels-public/v1/collection.json
        formats:        pmtiles, geoparquet
        "
      `);
    } finally {
      cap.restore();
    }
  });

  it("lists exports as a table and removes an export only with --yes", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "maui-parcels-public",
              layer: "maui-parcels/1",
              version: "v1",
              visibility: "public",
              status: "ready",
              collectionUrl: "https://data.honua.example/exports/maui-parcels-public/v1/collection.json",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const listCap = captureOutput();
    try {
      const code = await run(["export", "list"], { baseUrl: "https://honua.example", apiKey: "test-key" });
      expect(code).toBe(0);
      expect(listCap.stdout()).toMatchInlineSnapshot(`
        "Exports on https://honua.example
        ID                   LAYER           VERSION  VISIBILITY  STATUS  COLLECTION
        -------------------  --------------  -------  ----------  ------  -------------------------------------------------------------------------
        maui-parcels-public  maui-parcels/1  v1       public      ready   https://data.honua.example/exports/maui-parcels-public/v1/collection.json
        "
      `);
    } finally {
      listCap.restore();
    }

    // Refuses remove without --yes
    const refuseCap = captureOutput();
    try {
      const code = await run(["export", "remove", "maui-parcels-public"], {
        baseUrl: "https://honua.example",
        apiKey: "test-key",
      });
      expect(code).toBe(2);
      expect(refuseCap.stderr()).toContain("Re-run with --yes");
    } finally {
      refuseCap.restore();
    }

    // Removes with --yes
    const removeCap = captureOutput();
    try {
      const code = await run(["export", "remove", "maui-parcels-public", "--yes"], {
        baseUrl: "https://honua.example",
        apiKey: "test-key",
      });
      expect(code).toBe(0);
      expect(removeCap.stdout()).toMatchInlineSnapshot(`
        "Export removed
        exportId:  maui-parcels-public
        status:    removed
        "
      `);
    } finally {
      removeCap.restore();
    }
  });
});

describe("honua connection add --kind object-storage CLI", () => {
  it("prints the quick-create link and tests the connection when --id is supplied", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, status: "reachable" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const linkOnlyCap = captureOutput();
    try {
      const code = await run(
        ["connection", "add", "--kind", "object-storage", "--bucket", "honua-exports", "--region", "us-west-2"],
        { baseUrl: "https://honua.example", apiKey: "test-key" },
      );
      expect(code).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(linkOnlyCap.stdout()).toMatchInlineSnapshot(`
        "Add object-storage connection
        kind:            object-storage
        quickCreateUrl:  https://honua.example/console/connections/new?kind=object-storage&bucket=honua-exports&region=us-west-2

        Open the quick-create link to authorize object storage, then test it with:
          honua connection test <connectionId> --yes
        "
      `);
    } finally {
      linkOnlyCap.restore();
    }

    const testedCap = captureOutput();
    try {
      const code = await run(
        [
          "connection",
          "add",
          "--kind",
          "object-storage",
          "--bucket",
          "honua-exports",
          "--id",
          "obj-store-1",
          "--yes",
          "--json",
        ],
        { baseUrl: "https://honua.example", apiKey: "test-key" },
      );
      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(testedCap.stdout()) as {
        kind: string;
        quickCreateUrl: string;
        tested: boolean;
        receipt: { status: string; resourceRef?: { id?: string } };
      };
      expect(parsed.kind).toBe("object-storage");
      expect(parsed.quickCreateUrl).toBe(
        "https://honua.example/console/connections/new?kind=object-storage&bucket=honua-exports",
      );
      expect(parsed.tested).toBe(true);
      expect(parsed.receipt.status).toBe("ok");
      expect(parsed.receipt.resourceRef?.id).toBe("obj-store-1");
    } finally {
      testedCap.restore();
    }
  });

  it("rejects unsupported connection kinds", async () => {
    const cap = captureOutput();
    try {
      const code = await run(["connection", "add", "--kind", "bigquery"], {
        baseUrl: "https://honua.example",
        apiKey: "test-key",
      });
      expect(code).toBe(2);
      expect(cap.stderr()).toContain("object-storage");
    } finally {
      cap.restore();
    }
  });
});
