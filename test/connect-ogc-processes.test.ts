import { describe, expect, it, vi } from "vitest";

import { connect, discoverOgcProcesses } from "../src/connect.js";
import { HonuaAbortError } from "../src/core/errors.js";

const processesLanding = {
  title: "Geoprocessing Service",
  links: [
    { rel: "http://www.opengis.net/def/rel/ogc/1.0/processes", href: "./processes" },
    { rel: "conformance", href: "./conformance" },
    { rel: "self", href: "." },
  ],
};
const processesConformance = {
  conformsTo: [
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/ogc-process-description",
    "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/job-list",
  ],
};
const processesList = {
  processes: [
    { id: "buffer", title: "Buffer", description: "Buffer a geometry", version: "1.0.0" },
    { id: "hillshade", title: "Hillshade" },
  ],
};

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rawProcessesFetch(onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/processes") return json(processesLanding, { ETag: '"proc-root-v1"' });
    if (url.pathname === "/processes/conformance") return json(processesConformance, { ETag: '"proc-conf-v1"' });
    if (url.pathname === "/processes/processes") return json(processesList, { ETag: '"proc-list-v1"' });
    return new Response("not found", { status: 404 });
  });
}

describe("discoverOgcProcesses() — raw OGC API Processes capability/metadata discovery", () => {
  it("discovers the process list and effective processes capability against the raw root", async () => {
    const requests: string[] = [];
    const fetchFn = rawProcessesFetch((request) => requests.push(new URL(request.url).pathname));
    const result = await discoverOgcProcesses({
      endpoint: "https://proc.example/processes",
      clientOptions: { fetchFn },
    });

    // Three bounded metadata requests against the discovered root — not the facade.
    expect(requests).toEqual(["/processes", "/processes/conformance", "/processes/processes"]);
    expect(requests.some((path) => path === "/ogc/processes" || path.startsWith("/ogc/processes/"))).toBe(false);
    expect(result.endpoint).toBe("https://proc.example/processes");
    // Effective capability comes only from advertised conformance, intersected
    // against the Processes capability surface.
    expect([...result.capabilities]).toEqual(["processes"]);
    expect(result.processes.map((process) => process.id)).toEqual(["buffer", "hillshade"]);
    expect(result.processes[0]).toMatchObject({ id: "buffer", title: "Buffer", version: "1.0.0" });
    expect(result.diagnostics).toEqual([]);
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "https://proc.example/processes/conformance",
          validator: '"proc-conf-v1"',
        }),
      ]),
    );
  });

  it("reports an empty capability set and a diagnostic when Processes conformance is absent", async () => {
    const result = await discoverOgcProcesses({
      endpoint: "https://proc.example/processes",
      clientOptions: {
        fetchFn: vi.fn(async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === "/processes") return json(processesLanding);
          if (url.pathname === "/processes/conformance") return json({ conformsTo: [] });
          if (url.pathname === "/processes/processes") return json(processesList);
          return new Response("not found", { status: 404 });
        }),
      },
    });

    expect([...result.capabilities]).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "discovery-unavailable", severity: "warning" })]),
    );
  });

  it("accepts a conformant-but-empty processes catalog as a valid discovery", async () => {
    const result = await discoverOgcProcesses({
      endpoint: "https://proc.example/processes",
      clientOptions: {
        fetchFn: vi.fn(async (input, init) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === "/processes") return json(processesLanding);
          if (url.pathname === "/processes/conformance") return json(processesConformance);
          // A valid Processes endpoint with no registered processes.
          if (url.pathname === "/processes/processes") return json({ processes: [] });
          return new Response("not found", { status: 404 });
        }),
      },
    });

    // Empty catalog is not an error: the advertised capability still resolves.
    expect(result.processes).toEqual([]);
    expect([...result.capabilities]).toEqual(["processes"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects a Processes response missing the processes list", async () => {
    await expect(
      discoverOgcProcesses({
        endpoint: "https://proc.example/processes",
        clientOptions: {
          fetchFn: vi.fn(async (input, init) => {
            const url = new URL(new Request(input, init).url);
            if (url.pathname === "/processes") return json(processesLanding);
            if (url.pathname === "/processes/conformance") return json(processesConformance);
            // Malformed: no `processes` member at all.
            if (url.pathname === "/processes/processes") return json({ links: [] });
            return new Response("not found", { status: 404 });
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
  });

  it("rejects a Processes service whose landing advertises no processes link", async () => {
    const requested: string[] = [];
    await expect(
      discoverOgcProcesses({
        endpoint: "https://proc.example/processes",
        clientOptions: {
          fetchFn: vi.fn(async (input, init) => {
            const url = new URL(new Request(input, init).url);
            requested.push(url.pathname);
            if (url.pathname === "/processes")
              return json({ title: "no processes link", links: [{ rel: "self", href: "." }] });
            return json(processesList);
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    // Only the landing was fetched before rejecting.
    expect(requested).toEqual(["/processes"]);
  });

  it("cancels Processes discovery between the landing and follow-up requests", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const fetchFn = vi.fn(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      requested.push(url.pathname);
      controller.abort();
      if (url.pathname === "/processes") return json(processesLanding);
      return json(processesList);
    });
    await expect(
      discoverOgcProcesses({
        endpoint: "https://proc.example/processes",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(requested).toEqual(["/processes"]);
  });

  it("is not a Source-backed protocol: connect() refuses ogc-processes and points to discoverOgcProcesses", async () => {
    await expect(
      connect({
        endpoint: "https://proc.example/processes",
        // OGC API Processes is intentionally rejected by connect() — it is a
        // capability/metadata discovery result, not a Source.
        protocol: "ogc-processes" as never,
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: rawProcessesFetch() },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "unsupported-protocol" });
  });
});
