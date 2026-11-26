import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../src/cli/main.js";
import { captureOutput } from "./helpers/cli-output.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const options = { baseUrl: "https://honua.example", apiKey: "test-key" };
const source = { kind: "layer", serviceId: "maui-parcels", layerId: 1 };
const exportId = "maui-parcels";
const record = { id: exportId, title: "Maui parcels", source, versions: [] };

function response(data: unknown, status = 200) {
  return Response.json({ success: true, data }, { status });
}

const publicUrl = "https://data.honua.example/maui-parcels/v2/collection.json";
const pending = { ...record, status: "running", jobId: "job-2" };
const published = { ...pending, status: "ready", currentVersion: "v2", publicUrl };

it("requires --yes before submitting a --public export unless --dry-run is set", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const cap = captureOutput();
  expect(await run(["export", "maui-parcels/1", "--id", exportId, "--public"], options)).toBe(2);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(cap.stdout()).toBe("");
  expect(cap.stderr()).toContain("Re-run with --yes");
});

it("waits for the submitted job and snapshots confirmed public publication", async () => {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response(published));
  fetchMock.mockResolvedValueOnce(response(pending, 202));
  vi.stubGlobal("fetch", fetchMock);
  const cap = captureOutput();
  expect(await run(["export", "maui-parcels/1", "--id", exportId, "--public", "--yes"], options)).toBe(0);
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
  expect(await run(["export", "maui-parcels/1", "--public", "--yes", "--json"], options)).toBe(0);
  expect(JSON.parse(cap.stdout())).toEqual(published);
});

it("snapshots server refusal instead of claiming signed-in output is public", async () => {
  const refused = { ...published, publicUrl: undefined, notPublicReason: "Source requires authenticated access" };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(response(pending, 202)).mockResolvedValueOnce(response(refused)),
  );
  const cap = captureOutput();
  expect(await run(["export", "maui-parcels/1", "--public", "--yes"], options)).toBe(1);
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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(pending, 202)).mockResolvedValueOnce(response(result)));
  const cap = captureOutput();
  expect(await run(["export", "maui-parcels/1", "--public", "--yes"], options)).toBe(1);
  expect(cap.stdout()).toBe("");
  expect(cap.stderr()).not.toBe("");
});

it("preserves authorization refusal without polling", async () => {
  const fetchMock = vi.fn(async () => Response.json({ message: "Forbidden" }, { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  const cap = captureOutput();
  expect(await run(["export", "maui-parcels/1", "--public", "--yes"], options)).toBe(1);
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
  expect(await run(["export", "maui-parcels/1", "--public", "--yes"], options)).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(cap.stdout()).toBe("");
});

it("refuses to follow an unidentified submitted job", async () => {
  const fetchMock = vi.fn(async () => response({ ...pending, jobId: undefined }, 202));
  vi.stubGlobal("fetch", fetchMock);
  const cap = captureOutput();
  expect(await run(["export", "maui-parcels/1", "--public", "--yes"], options)).toBe(1);
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
  const result = run(["export", "maui-parcels/1", "--public", "--yes", "--timeout-ms", "100"], options);
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
  const result = run(["export", "maui-parcels/1", "--public", "--yes"], options);
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
  const result = run(["export", "maui-parcels/1", "--public", "--yes", "--timeout-ms", "100"], options);
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
    expect(await run(["export", "maui-parcels/1", "--public", "--yes", "--timeout-ms", timeout], options)).toBe(2);
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

it("prefers --admin-key for /api/v1/admin/exports and refuses non-loopback HTTP", async () => {
  let observedKey: string | null = null;
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    observedKey = new Headers(init?.headers).get("X-API-Key");
    return response(published);
  });
  fetchMock.mockResolvedValueOnce(response(pending, 202));
  vi.stubGlobal("fetch", fetchMock);
  const cap = captureOutput();
  const code = await run(
    ["export", "maui-parcels/1", "--id", exportId, "--public", "--yes", "--admin-key", "root-key"],
    {
      baseUrl: "https://honua.example",
      apiKey: "scoped-key",
    },
  );
  expect(code).toBe(0);
  expect(observedKey).toBe("root-key");
  expect(cap.stderr()).toBe("");

  const insecureCap = captureOutput();
  expect(
    await run(["export", "maui-parcels/1", "--public", "--yes"], { baseUrl: "http://remote.example", apiKey: "k" }),
  ).toBe(1);
  expect(insecureCap.stderr()).toContain("requires HTTPS");
});

it("preserves caller bearer token without substituting HONUA_ADMIN_KEY", async () => {
  vi.stubEnv("HONUA_ADMIN_KEY", "env-admin-key");
  let observedAuth: string | null = null;
  let observedKey: string | null = null;
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    observedAuth = headers.get("Authorization");
    observedKey = headers.get("X-API-Key");
    return response(published);
  });
  fetchMock.mockResolvedValueOnce(response(pending, 202));
  vi.stubGlobal("fetch", fetchMock);
  captureOutput();
  const code = await run(["export", "maui-parcels/1", "--public", "--yes"], {
    baseUrl: "https://honua.example",
    bearerToken: "caller-token",
  });
  expect(code).toBe(0);
  expect(observedAuth).toBe("Bearer caller-token");
  expect(observedKey).toBeNull();
});

it("surfaces the server's 404 failure message verbatim", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ success: false, message: "The source is not a routable Layer of that Service." }, { status: 404 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const cap = captureOutput();
  expect(await run(["export", "missing-svc/1", "--public", "--yes"], options)).toBe(1);
  expect(cap.stdout()).toBe("");
  expect(cap.stderr()).toContain("The source is not a routable Layer of that Service.");
});

it.each(["javascript:alert(1)", "   ", "/relative/collection.json"])(
  "rejects non-http publicUrl %s fail-closed",
  async (badUrl) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(pending, 202))
        .mockResolvedValueOnce(response({ ...published, publicUrl: badUrl })),
    );
    const cap = captureOutput();
    expect(await run(["export", "maui-parcels/1", "--public", "--yes"], options)).toBe(1);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain("is not public");
  },
);

function sendJson(
  res: import("node:http").ServerResponse,
  reply: { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> },
) {
  res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
  res.end(JSON.stringify(reply.body));
}

async function startExportServer(finalRecord: (origin: string) => Record<string, unknown>) {
  let getCount = 0;
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.headers["x-api-key"] !== "admin-secret") {
      return sendJson(res, { status: 403, body: { success: false, message: "Forbidden" } });
    }
    if (req.method === "POST" && req.url === "/api/v1/admin/exports") {
      return sendJson(res, {
        status: 202,
        headers: { location: `/api/v1/admin/exports/${exportId}` },
        body: {
          success: true,
          message: "Export started; a new Version appears when the job completes.",
          data: {
            ...pending,
            notPublicReason: "The public data path is not enabled for Exports on this installation.",
          },
        },
      });
    }
    if (req.method === "GET" && req.url === `/api/v1/admin/exports/${exportId}`) {
      getCount += 1;
      return sendJson(res, { status: 200, body: { success: true, data: finalRecord(origin) } });
    }
    return sendJson(res, { status: 404, body: { success: false, message: "Not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    getCount: () => getCount,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

it("completes server-confirmed public publication over loopback HTTP with admin key", async () => {
  const srv = await startExportServer((origin) => ({
    ...published,
    collectionUrl: `${origin}/api/v1/exports/${exportId}/v2/collection.json`,
    updatedAt: "2026-11-25T20:00:00Z",
    versions: [{ version: "v2", featureCount: 48, artifacts: [] }],
  }));
  try {
    const cap = captureOutput();
    const code = await run(["export", "maui-parcels/1", "--id", exportId, "--public", "--yes"], {
      baseUrl: srv.origin,
      adminKey: "admin-secret",
    });
    expect(code).toBe(0);
    expect(srv.getCount()).toBe(1);
    expect(cap.stdout()).toContain("Export published");
    expect(cap.stdout()).toContain(`publicUrl:      ${publicUrl}`);
    expect(cap.stdout()).toContain(`collectionUrl:  ${srv.origin}/api/v1/exports/${exportId}/v2/collection.json`);
    expect(cap.stderr()).toBe("");
  } finally {
    await srv.close();
  }
});

it.each([
  "stays on signed-in routes: anonymous read is not allowed",
  "stays on signed-in routes: row filter",
  "stays on signed-in routes: hidden field",
])("fails closed over loopback HTTP when server reports eligibility refusal: %s", async (reason) => {
  const srv = await startExportServer((origin) => ({
    ...pending,
    status: "ready",
    currentVersion: "v2",
    collectionUrl: `${origin}/api/v1/exports/${exportId}/v2/collection.json`,
    notPublicReason: reason,
  }));
  try {
    const cap = captureOutput();
    const code = await run(["export", "maui-parcels/1", "--id", exportId, "--public", "--yes"], {
      baseUrl: srv.origin,
      adminKey: "admin-secret",
    });
    expect(code).toBe(1);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toBe(`error: Export ${exportId} is not public: ${reason}.\n`);
  } finally {
    await srv.close();
  }
});
