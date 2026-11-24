import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/main.js";
import { captureOutput } from "./helpers/cli-output.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("honua export CLI", () => {
  const options = { baseUrl: "https://honua.example", apiKey: "test-key" };
  const source = { kind: "layer", serviceId: "maui-parcels", layerId: 1 };
  const exportId = "maui-parcels";
  const record = { id: exportId, title: "Maui parcels", source, versions: [] };

  function response(data: unknown, status = 200) {
    return Response.json({ success: true, data }, { status });
  }

  it("submits a signed-in layer export and displays the accepted job", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response({ ...record, status: "running", jobId: "job-1", notPublicReason: "Signed-in access" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--id", exportId], options)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://honua.example/api/v1/admin/exports");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ source, exportId });
    expect(cap.stdout()).toContain("Export submitted");
    expect(cap.stdout()).toContain("job-1");
    expect(cap.stdout()).toContain("running");
  });

  it("rejects malformed layer references without transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/2147483648"], options)).toBe(2);
    expect(cap.stderr()).toContain("<serviceId/layerId>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists exports and requires confirmation before unpublishing", async () => {
    const collectionUrl = "https://data.honua.example/collection.json";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE"
        ? response({ ...record, status: "unpublished" })
        : response({ items: [{ ...record, status: "ready", currentVersion: "v1", collectionUrl }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "list"], options)).toBe(0);
    expect(cap.stdout()).toContain("maui-parcels/1");
    expect(cap.stdout()).toContain("signed-in");
    expect(cap.stdout()).toContain(collectionUrl);
    expect(await run(["export", "remove", exportId], options)).toBe(2);
    expect(cap.stderr()).toContain("Re-run with --yes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await run(["export", "remove", exportId, "--yes"], options)).toBe(0);
    expect(cap.stdout()).toContain("Export unpublished");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://honua.example/api/v1/admin/exports/maui-parcels");
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
