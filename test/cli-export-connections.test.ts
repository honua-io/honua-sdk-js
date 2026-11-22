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
  vi.useRealTimers();
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

  const publicUrl = "https://data.honua.example/maui-parcels/v2/collection.json";
  const pending = { ...record, status: "running", jobId: "job-2" };
  const published = { ...pending, status: "ready", currentVersion: "v2", publicUrl };

  it("waits for the submitted job and snapshots confirmed public publication", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response(published));
    fetchMock.mockResolvedValueOnce(response(pending, 202));
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--id", exportId, "--public"], options)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://honua.example/api/v1/admin/exports");
    expect(JSON.parse(String(init?.body))).toEqual({ source, exportId });
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://honua.example/api/v1/admin/exports/maui-parcels");
    expect(cap.stdout()).toMatchInlineSnapshot(`
      "Export published
      id:         maui-parcels
      layer:      maui-parcels/1
      version:    v2
      status:     ready
      publicUrl:  https://data.honua.example/maui-parcels/v2/collection.json
      jobId:      job-2
      "
    `);
    expect(cap.stderr()).toBe("");
  });

  it("returns only the confirmed publication as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(pending, 202)).mockResolvedValueOnce(response(published));
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public", "--json"], options)).toBe(0);
    expect(JSON.parse(cap.stdout())).toEqual(published);
  });

  it("snapshots server refusal instead of claiming signed-in output is public", async () => {
    const refused = { ...published, publicUrl: undefined, notPublicReason: "Source requires authenticated access" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(response(pending, 202)).mockResolvedValueOnce(response(refused)),
    );
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public"], options)).toBe(1);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toMatchInlineSnapshot(`
      "error: Export maui-parcels is not public: Source requires authenticated access.
      "
    `);
  });

  it.each([
    { ...published, jobId: "older-job" },
    { ...published, id: "other-export" },
    { ...published, currentVersion: undefined },
    { ...published, status: "failed", message: "Export archive failed" },
    { ...published, message: "New job failed; older version retained" },
    { ...published, publicUrl: undefined, notPublicReason: "Public copy canary failed" },
  ])("does not report unconfirmed publication: %j", async (result) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(response(pending, 202)).mockResolvedValueOnce(response(result)),
    );
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public"], options)).toBe(1);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).not.toBe("");
  });

  it("preserves authorization refusal without polling", async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: "Forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public"], options)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cap.stdout()).toBe("");
  });

  it("preserves authorization refusal while checking publication", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(pending, 202))
      .mockResolvedValueOnce(Response.json({ message: "Forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public"], options)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cap.stdout()).toBe("");
  });

  it("refuses to follow an unidentified submitted job", async () => {
    const fetchMock = vi.fn(async () => response({ ...pending, jobId: undefined }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public"], options)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cap.stderr()).toContain("did not identify the submitted export job");
  });

  it("aborts an in-flight status request at the publication deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(pending, 202))
      .mockImplementationOnce(
        (_input: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    const result = run(["export", "maui-parcels/1", "--public", "--timeout-ms", "100"], options);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(1);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain("Timed out waiting for public export");
  });

  it("polls running jobs without treating an old public version as success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(pending, 202))
      .mockResolvedValueOnce(response({ ...published, status: "running" }))
      .mockResolvedValueOnce(response(published));
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    const result = run(["export", "maui-parcels/1", "--public"], options);
    await vi.advanceTimersByTimeAsync(0);
    expect(cap.stdout()).toBe("");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds polling and explains that a timed-out job can still finish", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(pending)),
    );
    const cap = captureOutput();
    const result = run(["export", "maui-parcels/1", "--public", "--timeout-ms", "100"], options);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(1);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain("Timed out waiting for public export maui-parcels (job job-2)");
    expect(cap.stderr()).toContain("check honua export list");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["0", "-1", "0.5", "NaN", "2147483648"])(
    "rejects invalid public wait timeout %s before submission",
    async (timeout) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      captureOutput();
      expect(await run(["export", "maui-parcels/1", "--public", "--timeout-ms", timeout], options)).toBe(2);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("previews public publication without transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public", "--dry-run", "--json"], options)).toBe(0);
    expect(JSON.parse(cap.stdout())).toMatchObject({ requirePublic: true, status: "dry-run", payload: { source } });
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
