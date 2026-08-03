import { describe, expect, it, vi } from "vitest";

import { connect, discoverOgcProcesses } from "../src/connect.js";
import { HonuaClient } from "../src/core/client.js";
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

const bufferDescription = {
  id: "buffer",
  title: "Buffer",
  version: "1.0.0",
  jobControlOptions: ["async-execute", "dismiss"],
  inputs: { geometry: { schema: { type: "object" } } },
  outputs: { result: { schema: { type: "object" } } },
};

/**
 * Fixture OGC API Processes server mounted under an arbitrary root. Every
 * route — landing, conformance, process list, process description, execution,
 * job status / results / dismiss — is derived from `mount`, so the same handler
 * stands in for a third-party deployment (`/pygeoapi`) and for the Honua facade
 * (`/ogc/processes`).
 */
function mountedProcessesServer(mount: string): { fetchFn: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  let jobPolls = 0;
  const fetchFn = vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === mount) return json(processesLanding);
    if (path === `${mount}/conformance`) return json(processesConformance);
    if (path === `${mount}/processes`) return json(processesList);
    if (path === `${mount}/processes/buffer`) return json(bufferDescription);
    if (path === `${mount}/processes/buffer/execution` && request.method === "POST") {
      return json({ jobID: "job-1", status: "accepted", processID: "buffer" });
    }
    if (path === `${mount}/jobs/job-1/results`) {
      // OGC API Processes §7.11.1: the document-mode body is the outputs map.
      return json({ result: { type: "Polygon", coordinates: [[[0, 0]]] } });
    }
    if (path === `${mount}/jobs/job-1` && request.method === "DELETE") {
      return json({ jobID: "job-1", processID: "buffer", status: "dismissed" });
    }
    if (path === `${mount}/jobs/job-1`) {
      const status = jobPolls === 0 ? "running" : "successful";
      jobPolls += 1;
      return json({ jobID: "job-1", processID: "buffer", status, progress: status === "running" ? 40 : 100 });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, requests };
}

describe("OGC API Processes execution against a discovered base path", () => {
  it("resolves describe / execute / job routes from the discovered root, never the facade prefix", async () => {
    const { fetchFn, requests } = mountedProcessesServer("/pygeoapi");
    const client = new HonuaClient({ baseUrl: "https://pygeoapi.example", fetchFn });

    const discovery = await discoverOgcProcesses({ endpoint: "https://pygeoapi.example/pygeoapi", client });
    // Discovery reports the raw service-root prefix so callers can bind a
    // handle without re-deriving it from the endpoint URL.
    expect(discovery.basePath).toBe("/pygeoapi");
    expect([...discovery.capabilities]).toEqual(["processes"]);

    const processes = client.ogcProcesses({ basePath: discovery.basePath });
    const description = await processes.describe("buffer");
    expect(description.id).toBe("buffer");

    const job = await processes.execute<Record<string, unknown>>({
      processId: "buffer",
      inputs: { geometry: { type: "Point", coordinates: [0, 0] } },
      mode: "async",
    });
    expect(job.id).toBe("job-1");
    expect(job.type).toBe("buffer");

    const result = await job.results({ pollIntervalMs: 0 });
    expect(result.outputs.result).toMatchObject({ type: "Polygon" });

    expect(requests).toEqual([
      "GET /pygeoapi",
      "GET /pygeoapi/conformance",
      "GET /pygeoapi/processes",
      "GET /pygeoapi/processes/buffer",
      "POST /pygeoapi/processes/buffer/execution",
      "GET /pygeoapi/jobs/job-1",
      "GET /pygeoapi/jobs/job-1",
      "GET /pygeoapi/jobs/job-1/results",
    ]);
    // The regression this guards: nothing rewrote a route back onto the facade.
    expect(requests.some((entry) => entry.includes("/ogc/processes"))).toBe(false);
  });

  it("keeps adopted jobs and cancellation pinned to the discovered root", async () => {
    const { fetchFn, requests } = mountedProcessesServer("/pygeoapi");
    const client = new HonuaClient({ baseUrl: "https://pygeoapi.example", fetchFn });
    const processes = client.ogcProcesses({ basePath: "/pygeoapi" });

    // A job adopted by id (reconnect after navigation) polls the same root.
    const adopted = processes.job("job-1", { processId: "buffer" });
    const snapshot = await adopted.poll();
    expect(snapshot.status).toBe("running");

    const job = await processes.execute({ processId: "buffer", mode: "async" });
    expect(await job.cancel()).toBe("dismissed");

    expect(requests).toEqual([
      "GET /pygeoapi/jobs/job-1",
      "POST /pygeoapi/processes/buffer/execution",
      "DELETE /pygeoapi/jobs/job-1",
    ]);
  });

  it("does not alias process descriptions across roots whose paths and ids contain colons", async () => {
    // `/a` + `b:c` and `/a:b` + `c` are distinct request URLs. A cache key that
    // concatenates the components with the same `:` separator it uses between
    // them would collapse both onto one entry and answer the second describe()
    // with the first process's metadata.
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      requests.push(path);
      if (path === "/a/processes/b%3Ac") return json({ id: "b:c", title: "Colon in the process id" });
      if (path === "/a:b/processes/c") return json({ id: "c", title: "Colon in the base path" });
      return new Response("not found", { status: 404 });
    });
    const client = new HonuaClient({ baseUrl: "https://proc.example", fetchFn });

    const first = await client.ogcProcesses({ basePath: "/a" }).describe("b:c");
    const second = await client.ogcProcesses({ basePath: "/a:b" }).describe("c");

    expect(first.id).toBe("b:c");
    expect(second.id).toBe("c");
    expect(requests).toEqual(["/a/processes/b%3Ac", "/a:b/processes/c"]);
  });

  it("still uses the Honua facade prefix when no base path is supplied", async () => {
    const { fetchFn, requests } = mountedProcessesServer("/ogc/processes");
    const client = new HonuaClient({ baseUrl: "https://honua.example", fetchFn });
    const processes = client.ogcProcesses();

    expect((await processes.list()).processes.map((process) => process.id)).toEqual(["buffer", "hillshade"]);
    expect((await processes.describe("buffer")).id).toBe("buffer");
    const job = await processes.execute<Record<string, unknown>>({ processId: "buffer", mode: "async" });
    expect((await job.results({ pollIntervalMs: 0 })).outputs.result).toMatchObject({ type: "Polygon" });
    expect(await processes.job("job-1").cancel()).toBe("dismissed");

    expect(requests).toEqual([
      "GET /ogc/processes/processes",
      "GET /ogc/processes/processes/buffer",
      "POST /ogc/processes/processes/buffer/execution",
      "GET /ogc/processes/jobs/job-1",
      "GET /ogc/processes/jobs/job-1",
      "GET /ogc/processes/jobs/job-1/results",
      "DELETE /ogc/processes/jobs/job-1",
    ]);
  });
});
