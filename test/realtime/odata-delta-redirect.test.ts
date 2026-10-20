import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOdataDeltaTransport } from "../../src/realtime/odata-delta.js";

const COLLECTION = "https://honua.example/odata/Incidents";
const DOCUMENT = { value: [{ Id: 1 }], "@odata.deltaLink": `${COLLECTION}?$deltatoken=next` };
const handles: { close(): void }[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

function subscribe(url: string, fetchImpl?: typeof fetch, resume = false) {
  const next = vi.fn();
  const error = vi.fn();
  const headers = vi.fn(() => ({ "X-API-Key": "test-key" }));
  const transport = createOdataDeltaTransport({
    url,
    pollIntervalMs: 60_000,
    entityId: (entity) => Number(entity.Id),
    headers,
    fetchImpl,
  });
  handles.push(
    transport.subscribe(
      { sourceId: "incidents", ...(resume ? { deltaToken: `${url}?$deltatoken=start` } : {}) },
      { next, error, complete() {} },
    ),
  );
  return { next, error, headers };
}

function redirect(status: number, location?: string, cancel = vi.fn(async () => {})): Response {
  return {
    status,
    ok: false,
    type: "basic",
    headers: new Headers(location === undefined ? {} : { Location: location }),
    body: { cancel },
  } as unknown as Response;
}

describe("OData delta redirect boundaries", () => {
  it.each([302, 307])("keeps custom headers on the collection origin with Node fetch (HTTP %s)", async (status) => {
    const received: IncomingHttpHeaders[] = [];
    const destination = await listen(
      createServer((request, response) => {
        received.push(request.headers);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(DOCUMENT));
      }),
    );
    const originalHeaders: IncomingHttpHeaders[] = [];
    const origin = await listen(
      createServer((request, response) => {
        originalHeaders.push(request.headers);
        response.writeHead(status, { Location: `${destination}/odata/Incidents` });
        response.end("Collection redirect");
      }),
    );
    const observer = subscribe(`${origin}/odata/Incidents`);
    await vi.waitFor(() =>
      expect(observer.error.mock.calls.length + observer.next.mock.calls.length).toBeGreaterThan(0),
    );
    expect(originalHeaders[0]?.["x-api-key"]).toBe("test-key");
    expect(received.map((headers) => headers["x-api-key"])).not.toContain("test-key");
    expect(received).toHaveLength(0);
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-event" }));
  });

  it.each([301, 302, 303, 307, 308])(
    "follows a relative same-collection redirect and cancels its body (HTTP %s)",
    async (status) => {
      const cancel = vi.fn(async () => {});
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(redirect(status, "Incidents/?page=2", cancel))
        .mockImplementationOnce(async () => {
          expect(cancel).toHaveBeenCalledOnce();
          return Response.json(DOCUMENT);
        });
      const observer = subscribe(COLLECTION, fetchImpl);
      await vi.waitFor(() => expect(observer.next).toHaveBeenCalledOnce());
      expect(observer.error).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${COLLECTION}/?page=2`);
      for (const [, init] of fetchImpl.mock.calls) {
        expect(init).toMatchObject({
          method: "GET",
          redirect: "manual",
          headers: { "X-API-Key": "test-key", Prefer: "odata.track-changes" },
        });
      }
    },
  );

  it.each([
    "https://other.example/odata/Incidents",
    "/odata/Other",
    "http://honua.example/odata/Incidents",
    "https://honua.example:8443/odata/Incidents",
    "http://[",
  ])("refuses an unvalidated redirect destination and cancels its body (%s)", async (location) => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect(302, location, cancel));
    const observer = subscribe(COLLECTION, fetchImpl);
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledOnce());
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-event" }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses an opaque browser redirect and cancels the available body", async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ...redirect(0, undefined, cancel), type: "opaqueredirect" });
    const observer = subscribe(COLLECTION, fetchImpl);
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledOnce());
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-event" }));
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses redirects without a Location header and cancels the body", async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect(302, undefined, cancel));
    const observer = subscribe(COLLECTION, fetchImpl);
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledOnce());
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-event" }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds same-collection redirects and cancels every redirect body", async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect(307, "?page=again", cancel));
    const observer = subscribe(COLLECTION, fetchImpl);
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledOnce());
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-event" }));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(cancel).toHaveBeenCalledTimes(6);
  });

  it("validates each redirect in a resumed delta request", async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect(307, "?page=2", cancel))
      .mockResolvedValueOnce(redirect(307, "https://other.example/odata/Incidents", cancel));
    const observer = subscribe(COLLECTION, fetchImpl, true);
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledOnce());
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-event" }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(new URL(String(url)).origin).toBe(new URL(COLLECTION).origin);
      expect(new Headers(init?.headers).get("Prefer")).toBeNull();
    }
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
