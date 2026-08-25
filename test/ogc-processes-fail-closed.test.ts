/**
 * honua-io/honua-sdk-js#1328 AC2: "Advertised `jobControlOptions` and
 * conformance classes gate execution modes fail closed."
 *
 * The existing suites prove the happy refusals — a process that advertises
 * only `async-execute` refuses `mode: "sync"`, and a server that never
 * declared the Dismiss class refuses `cancel()`. What they do not prove is the
 * harder half of "fail closed": that *silence* and *unrecognised declarations*
 * are refusals too. This suite drives one configurable OGC API Processes
 * fixture through the three ways a gate can quietly widen:
 *
 * 1. an omitted `jobControlOptions` read as "anything goes" rather than
 *    "nothing advertised";
 * 2. a conformance class the client does not recognise being accepted because
 *    it merely *contains* a class the client does recognise
 *    (`…/conf/dismiss-disabled` is not `…/conf/dismiss`);
 * 3. a cancel issued under `capabilityPolicy: "strict"` against a server that
 *    declared nothing at all — pretending, rather than reporting honestly.
 *
 * Every refusal here also asserts the request that was *not* sent: failing
 * closed after the POST is not failing closed.
 */

import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/core/client.js";

const MOUNT = "/proc";
const JOB_ID = "job-1";
const CORE_CLASS = "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core";
const DISMISS_CLASS = "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/dismiss";

interface FixtureOptions {
  /**
   * What the `buffer` description (and process summary) advertises.
   * `undefined` omits the member entirely — the case AC2 calls out; `[]`
   * publishes an explicitly empty declaration.
   */
  readonly jobControlOptions?: readonly string[] | undefined;
  /** Also publish `jobControlOptions` on the process-list summary. */
  readonly summarizeJobControl?: boolean;
  /** Body served at `/proc/conformance`; `{}` declares nothing. */
  readonly conformance?: Record<string, unknown>;
}

function json(body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * One OGC API Processes deployment mounted at `/proc`, with the declaration
 * members under test as knobs. It answers both Core execution shapes, so any
 * mode that gets past the gate reaches a real response rather than a 404 that
 * could be mistaken for a refusal.
 */
function fixture(options: FixtureOptions = {}): { client: HonuaClient; requests: string[] } {
  const requests: string[] = [];
  const declaration =
    options.jobControlOptions === undefined ? {} : { jobControlOptions: [...options.jobControlOptions] };
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === MOUNT) return json({ title: "Processes", links: [] });
    if (path === `${MOUNT}/conformance`) return json(options.conformance ?? { conformsTo: [CORE_CLASS] });
    if (path === `${MOUNT}/processes`) {
      return json({
        processes: [{ id: "buffer", title: "Buffer", ...(options.summarizeJobControl ? declaration : {}) }],
      });
    }
    if (path === `${MOUNT}/processes/buffer`) {
      return json({ id: "buffer", title: "Buffer", version: "1.0.0", ...declaration });
    }
    if (path === `${MOUNT}/processes/buffer/execution` && request.method === "POST") {
      if (request.headers.get("Prefer") === "respond-async") {
        return new Response(JSON.stringify({ jobID: JOB_ID, processID: "buffer", status: "accepted" }), {
          status: 201,
          headers: { "Content-Type": "application/json", Location: `https://proc.example${MOUNT}/jobs/${JOB_ID}` },
        });
      }
      return json({ result: { type: "Polygon", coordinates: [] } });
    }
    if (path === `${MOUNT}/jobs/${JOB_ID}` && request.method === "DELETE") {
      return json({ jobID: JOB_ID, processID: "buffer", status: "dismissed" });
    }
    if (path === `${MOUNT}/jobs/${JOB_ID}`) {
      return json({ jobID: JOB_ID, processID: "buffer", status: "successful", progress: 100 });
    }
    return new Response("not found", { status: 404 });
  });
  const client = new HonuaClient({
    baseUrl: "https://proc.example",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, requests };
}

const REFUSAL = "HonuaCapabilityNotSupportedError";

describe("ogc-processes fail-closed / advertised jobControlOptions", () => {
  /**
   * The full mode matrix, driven off one description each time. The rows that
   * matter most are the two with no `jobControlOptions` at all: a process that
   * advertises no execution mode has advertised no execution mode, and an
   * explicit `sync` / `async` request against it must be refused rather than
   * read as permission for everything.
   */
  it("gates an explicit mode on the exact declaration, and treats an omitted one as no declaration", async () => {
    const cases: ReadonlyArray<{
      readonly advertised: readonly string[] | undefined;
      readonly mode: "sync" | "async";
      readonly allowed: boolean;
    }> = [
      { advertised: ["async-execute"], mode: "sync", allowed: false },
      { advertised: ["sync-execute"], mode: "async", allowed: false },
      { advertised: ["sync-execute", "async-execute"], mode: "sync", allowed: true },
      { advertised: ["sync-execute", "async-execute"], mode: "async", allowed: true },
      // Case-insensitive, per the declaration comparison the SDK documents.
      { advertised: ["SYNC-EXECUTE"], mode: "sync", allowed: true },
      // The member is absent from the description: nothing is advertised.
      { advertised: undefined, mode: "sync", allowed: false },
      { advertised: undefined, mode: "async", allowed: false },
      // Present but empty: same answer, reached by the same rule.
      { advertised: [], mode: "async", allowed: false },
    ];

    for (const { advertised, mode, allowed } of cases) {
      const { client, requests } = fixture({ jobControlOptions: advertised });
      const processes = client.ogcProcesses({ basePath: MOUNT });
      await processes.describe("buffer");

      const label = `${JSON.stringify(advertised)} + mode=${mode}`;
      if (allowed) {
        const run = await processes.execute({ processId: "buffer", mode });
        expect(run, label).toBeTruthy();
        expect(requests, label).toContain("POST /proc/processes/buffer/execution");
        continue;
      }
      await expect(processes.execute({ processId: "buffer", mode }), label).rejects.toMatchObject({
        name: REFUSAL,
        capability: `processes.${mode === "sync" ? "sync-execute" : "async-execute"}`,
        protocol: "ogc-processes",
      });
      // Refused before the wire: the description read is the only request.
      expect(requests, label).toEqual(["GET /proc/processes/buffer"]);
    }
  });

  it("treats a process summary that omits jobControlOptions as advertising no mode", async () => {
    const { client, requests } = fixture({ jobControlOptions: undefined, summarizeJobControl: true });
    const processes = client.ogcProcesses({ basePath: MOUNT });
    await processes.list();

    await expect(processes.execute({ processId: "buffer", mode: "async" })).rejects.toMatchObject({
      name: REFUSAL,
      capability: "processes.async-execute",
      context: { declaredJobControlOptions: "" },
    });
    expect(requests).toEqual(["GET /proc/processes"]);
  });

  /**
   * The other half of "absence is a declaration": a *summary* may legally omit
   * what the full description carries, so a listing refresh must not be able to
   * downgrade a mode the description already declared. Failing closed on an
   * execution the server did declare is as wrong as permitting one it did not.
   */
  it("does not let a later list() downgrade the modes a describe() already learned", async () => {
    // The description declares async-execute; the listing summary omits the
    // member entirely, exactly as Core permits.
    const { client, requests } = fixture({ jobControlOptions: ["async-execute"] });
    const processes = client.ogcProcesses({ basePath: MOUNT });
    await processes.describe("buffer");
    await processes.list();

    const run = await processes.execute({ processId: "buffer", mode: "async" });
    expect(run.id).toBe(JOB_ID);
    expect(requests).toEqual([
      "GET /proc/processes/buffer",
      "GET /proc/processes",
      "POST /proc/processes/buffer/execution",
    ]);

    // Order does not rescue it either: the description still wins when it
    // arrives first *or* second.
    const reordered = fixture({ jobControlOptions: ["async-execute"] });
    const reorderedProcesses = reordered.client.ogcProcesses({ basePath: MOUNT });
    await reorderedProcesses.list();
    await reorderedProcesses.describe("buffer");
    await reorderedProcesses.execute({ processId: "buffer", mode: "async" });
    expect(reordered.requests).toContain("POST /proc/processes/buffer/execution");

    // And the precedence rule does not reopen the hole it sits next to: a
    // process this handle has only ever seen as a summary still refuses.
    const summaryOnly = fixture({ jobControlOptions: undefined, summarizeJobControl: true });
    const summaryProcesses = summaryOnly.client.ogcProcesses({ basePath: MOUNT });
    await summaryProcesses.list();
    await expect(summaryProcesses.execute({ processId: "buffer", mode: "async" })).rejects.toMatchObject({
      name: REFUSAL,
      capability: "processes.async-execute",
      context: { declaredJobControlOptions: "" },
    });
    expect(summaryOnly.requests).toEqual(["GET /proc/processes"]);
  });

  it("refuses under strict when the description it fetched declares no execution mode", async () => {
    const { client, requests } = fixture({ jobControlOptions: undefined });
    const processes = client.ogcProcesses({ basePath: MOUNT, capabilityPolicy: "strict" });

    await expect(processes.execute({ processId: "buffer", mode: "async" })).rejects.toMatchObject({
      name: REFUSAL,
      capability: "processes.async-execute",
      context: { declaredJobControlOptions: "" },
    });
    // It asked — conformance, then the description — and stopped there.
    expect(requests).toEqual(["GET /proc/conformance", "GET /proc/processes/buffer"]);
  });
});

describe("ogc-processes fail-closed / conformance classes", () => {
  it("does not let a class that merely extends the Core class widen execution", async () => {
    // `…/conf/core-lite` is not the Core class. A substring test would say it
    // is, and would hand the caller an execution the server never declared.
    const narrowed = fixture();
    const processes = narrowed.client.ogcProcesses({
      basePath: MOUNT,
      conformance: { conformsTo: [`${CORE_CLASS}-lite`] },
    });
    await expect(processes.execute({ processId: "buffer" })).rejects.toMatchObject({
      name: REFUSAL,
      capability: "processes.execute",
      context: { missingClass: CORE_CLASS },
    });
    expect(narrowed.requests).toEqual([]);

    // Control on the other side of the line: the same class published under a
    // different host and path prefix is still the Core class, and still runs.
    const vendor = fixture();
    const vendorProcesses = vendor.client.ogcProcesses({
      basePath: MOUNT,
      conformance: { conformsTo: ["https://vendor.example/standards/ogcapi-processes-1/1.0/conf/core"] },
    });
    await vendorProcesses.execute({ processId: "buffer" });
    expect(vendor.requests).toEqual(["POST /proc/processes/buffer/execution"]);
  });

  it("does not let a class that merely extends the Dismiss class widen cancellation", async () => {
    const denied = fixture();
    const deniedProcesses = denied.client.ogcProcesses({
      basePath: MOUNT,
      // A server that publishes a "dismiss-disabled" class has said the
      // opposite of what the Dismiss class says.
      conformance: { conformsTo: [CORE_CLASS, `${DISMISS_CLASS}-disabled`] },
    });
    const deniedRun = await deniedProcesses.execute({
      processId: "buffer",
      mode: "async",
      jobControlOptions: ["async-execute"],
    });
    await expect(deniedRun.cancel()).rejects.toMatchObject({
      name: REFUSAL,
      capability: "processes.dismiss",
      context: { missingClass: DISMISS_CLASS },
    });
    // No speculative DELETE.
    expect(denied.requests).toEqual(["POST /proc/processes/buffer/execution"]);

    // Control: the real class, and the DELETE goes out.
    const allowed = fixture();
    const allowedProcesses = allowed.client.ogcProcesses({
      basePath: MOUNT,
      conformance: { conformsTo: [CORE_CLASS, DISMISS_CLASS] },
    });
    const allowedRun = await allowedProcesses.execute({
      processId: "buffer",
      mode: "async",
      jobControlOptions: ["async-execute"],
    });
    expect(await allowedRun.cancel()).toBe("dismissed");
    expect(allowed.requests).toEqual(["POST /proc/processes/buffer/execution", "DELETE /proc/jobs/job-1"]);
  });

  it("refuses under strict when the fetched conformance document declares nothing", async () => {
    // A `/conformance` response with no `conformsTo` is not a blank cheque: a
    // handle that resolves declarations for itself got its answer.
    const { client, requests } = fixture({ conformance: {} });
    const processes = client.ogcProcesses({ basePath: MOUNT, capabilityPolicy: "strict" });

    await expect(processes.execute({ processId: "buffer", mode: "async" })).rejects.toMatchObject({
      name: REFUSAL,
      capability: "processes.execute",
      context: { missingClass: CORE_CLASS },
    });
    expect(requests).toEqual(["GET /proc/conformance"]);
  });
});

describe("ogc-processes fail-closed / cancellation honesty", () => {
  it("refuses to cancel under strict when nothing declares dismissal", async () => {
    // An adopted job with a server-advertised status route: the route gate is
    // satisfied, so the only question left is whether dismissal was declared.
    // Nothing declared it, and `strict` promised not to guess.
    const { client, requests } = fixture();
    const run = client.ogcProcesses({ basePath: MOUNT, capabilityPolicy: "strict" }).job(JOB_ID, {
      processId: "buffer",
      statusPath: `${MOUNT}/jobs/${JOB_ID}`,
    });

    await expect(run.cancel()).rejects.toMatchObject({
      name: REFUSAL,
      capability: "processes.dismiss",
      context: { missingClass: DISMISS_CLASS },
    });
    expect(requests).toEqual([]);

    // The other side of the same gate: a declaration in hand is enough, and it
    // does not need the conformance document to say so twice.
    const declared = fixture({ jobControlOptions: ["async-execute", "dismiss"] });
    const processes = declared.client.ogcProcesses({ basePath: MOUNT, capabilityPolicy: "strict" });
    const declaredRun = await processes.execute({ processId: "buffer", mode: "async" });

    expect(await declaredRun.cancel()).toBe("dismissed");
    expect(declared.requests).toEqual([
      "GET /proc/conformance",
      "GET /proc/processes/buffer",
      "POST /proc/processes/buffer/execution",
      "DELETE /proc/jobs/job-1",
    ]);
  });
});
