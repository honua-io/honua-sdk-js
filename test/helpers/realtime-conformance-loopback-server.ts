/**
 * Loopback stand-in for honua-server's controlled-conformance mutation surface
 * (honua-server#3038 / PR #3154) and the streaming-features endpoint it
 * publishes on.
 *
 * The scheduled live lane is the only thing that talks to a real deployment.
 * This server lets the always-on unit lane drive the *same* client over the
 * same wire contract with no network access, so the run lifecycle, the
 * digest-reversal proof, cross-transport reconciliation, and every fail-closed
 * arm are regression-tested on every commit.
 *
 * It is deliberately faithful where faithfulness is load-bearing:
 *
 * - the batched baseline frame always writes `geometry`, even when null, while
 *   the delta envelope drops a null one — the exact asymmetry that makes a
 *   geometry-less conformance source fail;
 * - `touch` republishes a record without changing it, so transports opened at
 *   different times converge on one normalized state;
 * - unknown-run and foreign-record both answer `404`, so the surface cannot be
 *   used to confirm that another run's records exist.
 */

import { createHash, randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Attribute carrying the ownership marker on controlled records. */
export const CONFORMANCE_RUN_ID_FIELD = "conformance_run_id";
/** Attribute carrying the caller label on controlled records. */
export const CONFORMANCE_LABEL_FIELD = "conformance_label";
/** Dedicated conformance service the fixture provisions. */
export const CONFORMANCE_SERVICE_ID = "conformance-probe";
/** Dedicated conformance layer within that service. */
export const CONFORMANCE_LAYER_ID = 0;
/** Immutable deployment revision the fixture binds runs to. */
export const CONFORMANCE_DEPLOYMENT_REVISION = `sha256:${"ab".repeat(32)}`;

type Json = Record<string, unknown>;

interface ControlledRecord {
  readonly objectId: number;
  readonly runId: string;
  geometry: Json | null;
  attributes: Json;
}

export interface ConformanceLoopbackOptions {
  /** Advertise and serve the controlled-conformance surface at all. */
  readonly conformanceEnabled?: boolean;
  /** Serve `404` on the lease route, modelling a deployment that predates it. */
  readonly leaseRouteAbsent?: boolean;
  /** Answer `503`: the configured source does not resolve as a writable layer. */
  readonly sourceUnavailable?: boolean;
  /** Answer `503`: the deployment publishes no immutable revision to bind to. */
  readonly revisionUnavailable?: boolean;
  /** Leases available at once. A second lease answers `409` (default 1). */
  readonly maxConcurrentRuns?: number;
  /** Mutations one run may apply before `409` (default 32). */
  readonly maxMutationsPerRun?: number;
  /** Give controlled records no geometry, modelling a mis-provisioned source. */
  readonly recordsWithoutGeometry?: boolean;
  /** Report a cleanup digest that does not reverse to the lease digest. */
  readonly leaveBaselineResidue?: boolean;
  /**
   * Lease a run bound to a revision other than the one the capability document
   * advertises, modelling a redeploy between discovery and lease.
   */
  readonly leaseRevisionDrift?: boolean;
  /** Advertised transport identities (default SSE + WebSocket). */
  readonly transports?: readonly string[];
}

export interface ConformanceLoopbackServer {
  readonly baseUrl: string;
  /** Requests the fixture answered, for token-leak and call-shape assertions. */
  readonly requests: ReadonlyArray<{ readonly method: string; readonly path: string; readonly headers: Json }>;
  /** Controlled records currently present in the conformance source. */
  readonly controlledRecordCount: number;
  /**
   * Build a WebSocket factory that attaches to the same in-memory event log the
   * SSE endpoint streams from. The SDK's WebSocket transport is exercised end to
   * end without standing up a second protocol server.
   */
  webSocketFactory(): (url: string, protocols?: string | readonly string[]) => WebSocketLike;
  close(): Promise<void>;
}

interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(payload: string): void;
  close(): void;
}

interface Subscriber {
  readonly write: (frame: Json) => void;
  /** Sequences are subscription-local: the baseline is 0 and deltas continue at 1. */
  sequence: number;
  closed: boolean;
}

/** Baseline records that no run owns. Their digest is what a run must reverse to. */
const BASELINE_RECORDS: readonly ControlledRecord[] = Object.freeze([
  Object.freeze({
    objectId: 1,
    runId: "",
    geometry: { type: "Point", coordinates: [-156.45, 20.88] } as Json,
    attributes: { OBJECTID: 1, name: "baseline-alpha", [CONFORMANCE_RUN_ID_FIELD]: null } as Json,
  }),
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const entries = Object.keys(value as Json)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`);
  return `{${entries.join(",")}}`;
}

export async function startConformanceLoopbackServer(
  options: ConformanceLoopbackOptions = {},
): Promise<ConformanceLoopbackServer> {
  const conformanceEnabled = options.conformanceEnabled ?? true;
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 1;
  const maxMutationsPerRun = options.maxMutationsPerRun ?? 32;
  const transports = options.transports ?? ["sse", "websocket"];

  const requests: Array<{ method: string; path: string; headers: Json }> = [];
  const runs = new Map<string, { token: string; marker: string; mutations: number; owned: Set<number> }>();
  const controlled = new Map<number, ControlledRecord>();
  const subscribers = new Set<Subscriber>();
  let nextObjectId = 100;
  let changeCursor = 4_800;

  const baselineDigest = (): string =>
    sha256(canonical([...BASELINE_RECORDS].map((record) => ({ id: record.objectId, attributes: record.attributes }))));

  const allRecords = (): ControlledRecord[] => [...BASELINE_RECORDS, ...controlled.values()];

  const snapshotFrame = (subscriptionId: string): Json => ({
    type: "snapshot",
    snapshotId: randomUUID(),
    subscriptionId,
    sequence: 0,
    // honua-server emits the global event-store position as a JSON number.
    cursor: changeCursor,
    reason: "initial",
    replace: true,
    serviceId: CONFORMANCE_SERVICE_ID,
    layerIds: [CONFORMANCE_LAYER_ID],
    featureCount: allRecords().length,
    complete: true,
    features: allRecords().map((record) => ({
      id: String(record.objectId),
      sourceId: CONFORMANCE_SERVICE_ID,
      layerId: CONFORMANCE_LAYER_ID,
      geometryCrs: "EPSG:4326",
      feature: {
        type: "Feature",
        id: String(record.objectId),
        // Written even when null: a GeoJSON Feature must carry the member.
        geometry: record.geometry,
        properties: record.attributes,
      },
    })),
    timestamp: "2026-08-04T00:00:00.000Z",
  });

  const publish = (record: ControlledRecord, operation: "insert" | "update" | "delete"): void => {
    changeCursor += 1;
    const version = changeCursor;
    for (const subscriber of subscribers) {
      if (subscriber.closed) continue;
      subscriber.sequence += 1;
      subscriber.write({
        type: "feature-change",
        serviceId: CONFORMANCE_SERVICE_ID,
        featureId: String(record.objectId),
        objectId: record.objectId,
        operation,
        version,
        timestamp: "2026-08-04T00:00:05.000Z",
        eventId: `conformance-${operation}-${String(record.objectId)}-${String(subscriber.sequence)}`,
        sequence: subscriber.sequence,
        cursor: String(changeCursor),
        ...(operation === "delete"
          ? {}
          : {
              // Faithful to the server: a null geometry is dropped from the
              // delta envelope, which is exactly why a geometry-less
              // conformance source cannot produce a decodable after-image.
              ...(record.geometry === null ? {} : { geometry: record.geometry }),
              attributes: record.attributes,
            }),
      });
    }
  };

  const capabilities = (): Json => ({
    enabled: true,
    transports,
    modes: ["delta", "snapshot", "snapshot-then-delta"],
    subscriptionSequence: true,
    serverVersion: "1.0.0-loopback",
    deploymentRevision: CONFORMANCE_DEPLOYMENT_REVISION,
    serverRevision: CONFORMANCE_DEPLOYMENT_REVISION,
    deploymentRevisionSource: "image-digest",
    replaySupported: true,
    conformance: conformanceEnabled
      ? {
          enabled: true,
          serviceId: CONFORMANCE_SERVICE_ID,
          layerId: CONFORMANCE_LAYER_ID,
          runIdField: CONFORMANCE_RUN_ID_FIELD,
          maxConcurrentRuns,
          activeRuns: runs.size,
          runTtlSeconds: 300,
          maxMutationsPerRun,
          maxRecordsPerRun: 8,
          operations: ["insert", "update", "touch", "delete"],
        }
      : { enabled: false },
    layers: [{ layerId: CONFORMANCE_LAYER_ID, canSubscribe: true }],
  });

  // Streamed responses keep their socket open, and `server.close()` waits for
  // every one of them. Tracking sockets lets teardown stay deterministic
  // instead of depending on the client having already aborted.
  const sockets = new Set<{ destroy: () => void }>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    requests.push({ method: request.method ?? "GET", path: url.pathname, headers: { ...request.headers } });
    void route(request, response, url);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const route = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (url.pathname === "/api/v1/streaming/features/capabilities") {
      return sendJson(response, 200, capabilities());
    }
    if (url.pathname === "/api/v1/streaming/features") {
      return streamSse(response, url);
    }
    if (url.pathname === "/api/v1/streaming/conformance/runs" && request.method === "POST") {
      return leaseRun(request, response);
    }
    const runRoute = /^\/api\/v1\/streaming\/conformance\/runs\/([^/]+)(\/mutations)?$/u.exec(url.pathname);
    if (runRoute) {
      const runId = decodeURIComponent(runRoute[1] ?? "");
      if (runRoute[2] && request.method === "POST") return mutateRun(request, response, runId);
      if (!runRoute[2] && request.method === "DELETE") return releaseRun(request, response, runId);
    }
    return sendProblem(response, 404, "No route matches that request.");
  };

  const leaseRun = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (options.leaseRouteAbsent) return sendProblem(response, 404, "No route matches that request.");
    if (!conformanceEnabled) {
      return sendProblem(response, 403, "This deployment provisions no controlled-conformance source.");
    }
    if (options.sourceUnavailable) {
      return sendProblem(response, 503, "The configured conformance source is not a writable layer.");
    }
    if (options.revisionUnavailable) {
      return sendProblem(response, 503, "This deployment reports no immutable revision to bind evidence to.");
    }
    if (runs.size >= maxConcurrentRuns) {
      return sendProblem(response, 409, "Every controlled-conformance lease is currently held.");
    }
    const body = await readJson(request);
    const expectedRevision =
      typeof body?.expectedDeploymentRevision === "string" ? body.expectedDeploymentRevision : undefined;
    if (
      !options.leaseRevisionDrift &&
      expectedRevision !== undefined &&
      expectedRevision !== CONFORMANCE_DEPLOYMENT_REVISION
    ) {
      return sendProblem(response, 409, "The expected deployment revision does not match this deployment.");
    }
    const expectedServiceId = typeof body?.expectedServiceId === "string" ? body.expectedServiceId : undefined;
    if (expectedServiceId !== undefined && expectedServiceId !== CONFORMANCE_SERVICE_ID) {
      return sendProblem(response, 409, "The expected conformance service does not match this deployment.");
    }
    const runId = randomUUID().replaceAll("-", "");
    const marker = `honua-conformance:${runId}:${String(Math.floor(Date.now() / 1000) + 300)}`;
    runs.set(runId, { token: `run-token-${randomUUID()}`, marker, mutations: 0, owned: new Set() });
    return sendJson(response, 201, {
      success: true,
      data: {
        runId,
        runToken: runs.get(runId)?.token,
        runMarker: marker,
        serviceId: CONFORMANCE_SERVICE_ID,
        layerId: CONFORMANCE_LAYER_ID,
        runIdField: CONFORMANCE_RUN_ID_FIELD,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        remainingMutations: maxMutationsPerRun,
        maxRecords: 8,
        deploymentRevision: options.leaseRevisionDrift ? `sha256:${"cd".repeat(32)}` : CONFORMANCE_DEPLOYMENT_REVISION,
        baselineDigest: baselineDigest(),
        baselineRecordCount: BASELINE_RECORDS.length,
      },
      timestamp: new Date().toISOString(),
    });
  };

  const mutateRun = async (request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> => {
    const run = authorize(request, runId);
    // Unknown run and wrong token are indistinguishable, on purpose.
    if (!run) return sendProblem(response, 404, "No live conformance run matches that identifier and token.");
    const body = await readJson(request);
    const operation = typeof body?.operation === "string" ? body.operation : "";
    if (!["insert", "update", "touch", "delete"].includes(operation)) {
      return sendProblem(response, 400, "A JSON body naming the conformance operation is required.");
    }
    if (run.mutations >= maxMutationsPerRun) {
      return sendProblem(response, 409, "This run exhausted its mutation budget.");
    }
    run.mutations += 1;

    if (operation === "insert") {
      nextObjectId += 1;
      const objectId = nextObjectId;
      const record: ControlledRecord = {
        objectId,
        runId,
        geometry: options.recordsWithoutGeometry ? null : { type: "Point", coordinates: [-20.5, 10.25] },
        attributes: {
          OBJECTID: objectId,
          [CONFORMANCE_RUN_ID_FIELD]: run.marker,
          [CONFORMANCE_LABEL_FIELD]: typeof body?.label === "string" ? body.label : null,
        },
      };
      controlled.set(objectId, record);
      run.owned.add(objectId);
      publish(record, "insert");
      return sendMutation(response, runId, run, operation, objectId);
    }

    const objectId = typeof body?.objectId === "number" ? body.objectId : Number.NaN;
    const record = controlled.get(objectId);
    // Ownership is re-read from the stored row: a foreign record answers the
    // same 404 as an unknown run.
    if (!record || record.runId !== runId) {
      return sendProblem(response, 404, "No controlled record with that identifier is owned by this run.");
    }
    if (operation === "delete") {
      controlled.delete(objectId);
      run.owned.delete(objectId);
      publish(record, "delete");
      return sendMutation(response, runId, run, operation, objectId);
    }
    if (operation === "update" && typeof body?.label === "string") {
      record.attributes = { ...record.attributes, [CONFORMANCE_LABEL_FIELD]: body.label };
    }
    // `touch` rewrites the record with the values it already has.
    publish(record, "update");
    return sendMutation(response, runId, run, operation, objectId);
  };

  const releaseRun = async (request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> => {
    const run = authorize(request, runId);
    if (!run) return sendProblem(response, 404, "No live conformance run matches that identifier and token.");
    let deleted = 0;
    for (const objectId of run.owned) {
      if (controlled.delete(objectId)) deleted += 1;
    }
    runs.delete(runId);
    return sendJson(response, 200, {
      success: true,
      data: {
        runId,
        deletedRecords: deleted,
        baselineDigest: options.leaveBaselineResidue ? sha256(`residue:${runId}`) : baselineDigest(),
        baselineRecordCount: BASELINE_RECORDS.length,
        baselineRestored: !options.leaveBaselineResidue && controlled.size === 0,
      },
      timestamp: new Date().toISOString(),
    });
  };

  const sendMutation = (
    response: ServerResponse,
    runId: string,
    run: { marker: string; mutations: number; owned: Set<number> },
    operation: string,
    objectId: number,
  ): void =>
    sendJson(response, 200, {
      success: true,
      data: {
        runId,
        operation,
        objectId,
        mutationOrdinal: run.mutations,
        remainingMutations: maxMutationsPerRun - run.mutations,
        ownedRecords: run.owned.size,
        runMarker: run.marker,
      },
      timestamp: new Date().toISOString(),
    });

  const authorize = (
    request: IncomingMessage,
    runId: string,
  ): { token: string; marker: string; mutations: number; owned: Set<number> } | undefined => {
    const run = runs.get(runId);
    const token = request.headers["x-honua-conformance-run-token"];
    return run && typeof token === "string" && token === run.token ? run : undefined;
  };

  const streamSse = (response: ServerResponse, url: URL): void => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const subscriptionId = url.searchParams.get("requestId") ?? "loopback";
    const subscriber: Subscriber = {
      closed: false,
      sequence: 0,
      write: (frame) => {
        if (!subscriber.closed) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      },
    };
    subscribers.add(subscriber);
    response.on("close", () => {
      subscriber.closed = true;
      subscribers.delete(subscriber);
    });
    subscriber.write(snapshotFrame(subscriptionId));
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    get controlledRecordCount() {
      return controlled.size;
    },
    webSocketFactory() {
      return () => {
        const socket: WebSocketLike = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send() {},
          close() {
            subscriber.closed = true;
            subscribers.delete(subscriber);
          },
        };
        const subscriber: Subscriber = {
          closed: false,
          sequence: 0,
          write: (frame) => socket.onmessage?.({ data: JSON.stringify(frame) }),
        };
        subscribers.add(subscriber);
        queueMicrotask(() => {
          socket.onopen?.({});
          subscriber.write(snapshotFrame("loopback-websocket"));
        });
        return socket;
      };
    },
    close() {
      for (const subscriber of subscribers) subscriber.closed = true;
      subscribers.clear();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload, "utf8")),
  });
  response.end(payload);
}

function sendProblem(response: ServerResponse, status: number, detail: string): void {
  sendJson(response, status, {
    type: "https://honua.io/problems/controlled-conformance",
    title: "Controlled conformance request refused",
    status,
    detail,
  });
}

async function readJson(request: IncomingMessage): Promise<Json | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
}
