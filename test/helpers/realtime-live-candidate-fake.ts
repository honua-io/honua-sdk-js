/**
 * In-process stand-in for the isolated two-tenant honua-server candidate the
 * live authorization receipt producer (#1692) drives on the exact image.
 *
 * It models the wire contract the producer depends on: HS256 relay JWTs
 * exchanged at generateToken for opaque portal tokens with a server-reported
 * expiry, RFC 7009 revocation, periodic revalidation of live subscriptions that
 * ends SSE with a typed status event and WebSocket with close 1008, OData delta
 * links with `@odata.nextLink` paging, tenant-scoped feature layers 10/11, and
 * tenant-tagged SensorThings observations whose ids repeat across tenants just
 * as they do on the candidate.
 *
 * Each `defects` switch reproduces one behaviour observed on the candidate
 * (honua-server#4776, #4777, #4778) or a cross-tenant leak, so the tests prove
 * the producer records a failed row rather than a passed one.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "close", listener: () => void): void;
}

interface WsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WsSocket) => void): void;
  close(): void;
}

// `ws` ships no type declarations; only the two members used here are typed.
const { WebSocketServer } = createRequire(import.meta.url)("ws") as {
  WebSocketServer: new (options: { noServer: true }) => WsServer;
};

export const FAKE_CANDIDATE_REVISION = "0f".repeat(20);
export const FAKE_CANDIDATE_IMAGE = `sha256:${"d5".repeat(32)}`;

const LAYER_TENANTS: Readonly<Record<string, string>> = { "10": "tenant-a", "11": "tenant-b" };
const DEFAULT_TENANT = "public";

export interface FakeCandidateDefects {
  /** Deliver every layer's feature changes to every feature subscription. */
  readonly leakForeignFeatures?: boolean;
  /** Drop a feature-stream WebSocket without a close frame when authorization ends (honua-server#4776). */
  readonly featureWebSocketAbortsWithoutClose?: boolean;
  /** Answer 404 instead of 401 when an OData credential is missing, expired or revoked (honua-server#4778). */
  readonly odataConcealsUnauthorized?: boolean;
  /** Stop validating tokens this many milliseconds before their advertised expiry (honua-server#4777). */
  readonly expireEarlyMs?: number;
}

export interface FakeCandidateOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly signingKey: string;
  readonly adminApiKey: string;
  /** Wall-clock length of one token-lifetime "minute" (default 1500 ms). */
  readonly minuteMs?: number;
  /** Live-subscription revalidation period (default 100 ms). */
  readonly revalidationMs?: number;
  /** OData page size, small so paging is always exercised (default 2). */
  readonly odataPageSize?: number;
  readonly defects?: FakeCandidateDefects;
}

export interface FakeCandidate {
  readonly baseUrl: string;
  /** Every portal token issued, for the no-retained-credential assertion. */
  readonly issuedTokens: readonly string[];
  close(): Promise<void>;
}

interface Credential {
  readonly tenant: string;
  readonly roles: readonly string[];
  readonly expiresAt: number;
  revoked: boolean;
}

interface FeatureEvent {
  readonly cursor: number;
  readonly layerId: number;
  readonly objectId: number;
  readonly name: string;
}

interface Observation {
  readonly iotId: number;
  readonly tenant: string;
  readonly result: number;
}

type Json = Record<string, unknown>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

function featureFrame(event: FeatureEvent): Json {
  return {
    type: "feature-change",
    cursor: event.cursor,
    serviceId: "test_service",
    layerId: event.layerId,
    objectId: event.objectId,
    operation: "insert",
    attributes: { name: event.name, objectid: event.objectId },
  };
}

export async function startFakeCandidate(options: FakeCandidateOptions): Promise<FakeCandidate> {
  const minuteMs = options.minuteMs ?? 1_500;
  const revalidationMs = options.revalidationMs ?? 100;
  const pageSize = options.odataPageSize ?? 2;
  const defects = options.defects ?? {};
  const credentials = new Map<string, Credential>();
  const issuedTokens: string[] = [];
  const relayIds = new Set<string>();
  const events: FeatureEvent[] = [];
  const observationIds = new Map<string, number>();
  const featureSubscribers = new Set<(event: FeatureEvent) => void>();
  const observationSubscribers = new Set<(observation: Observation) => void>();
  const openStreams = new Set<() => void>();
  const sockets = new Set<Duplex>();
  const webSockets = new WebSocketServer({ noServer: true });
  let cursor = 0;
  let nextObjectId = 0;

  function validCredential(token: string | null): Credential | null {
    if (!token) return null;
    const credential = credentials.get(token);
    if (!credential || credential.revoked) return null;
    return Date.now() < credential.expiresAt - (defects.expireEarlyMs ?? 0) ? credential : null;
  }

  function verifyRelay(jwt: string): Json | null {
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) return null;
    const expected = createHmac("sha256", options.signingKey).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Json;
    if (claims.iss !== options.issuer || claims.aud !== options.audience) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    // Like the candidate, a replayed relay JWT is refused.
    if (typeof claims.jti !== "string" || relayIds.has(claims.jti)) return null;
    relayIds.add(claims.jti);
    return claims;
  }

  function tokenFrom(request: IncomingMessage, url: URL): string | null {
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice(7);
    return url.searchParams.get("token");
  }

  /** Ends a live subscription once its credential stops validating. */
  function revalidate(token: string, end: () => void): () => void {
    const timer = setInterval(() => {
      if (!validCredential(token)) {
        clearInterval(timer);
        end();
      }
    }, revalidationMs);
    return () => clearInterval(timer);
  }

  function publishFeature(layerId: number, name: string): FeatureEvent {
    cursor += 1;
    nextObjectId += 1;
    const event = { cursor, layerId, objectId: nextObjectId, name };
    events.push(event);
    for (const subscriber of featureSubscribers) subscriber(event);
    return event;
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://candidate.invalid");
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /api/v1/streaming/features/capabilities") {
      sendJson(response, 200, {
        success: true,
        data: {
          enabled: true,
          edition: "Pro",
          deploymentRevision: FAKE_CANDIDATE_REVISION,
          deploymentRevisionSource: "commit-sha",
        },
      });
      return;
    }

    if (route === "POST /sharing/rest/generateToken") {
      const form = new URLSearchParams(await readBody(request));
      const claims = verifyRelay(form.get("password") ?? "");
      if (!claims) {
        sendJson(response, 400, { error: { code: 400, message: "Unable to generate token." } });
        return;
      }
      const token = randomBytes(32).toString("hex");
      const expiresAt = Date.now() + Number(form.get("expiration") ?? "60") * minuteMs;
      credentials.set(token, {
        tenant: typeof claims.tenant_id === "string" ? claims.tenant_id : DEFAULT_TENANT,
        roles: Array.isArray(claims.roles) ? (claims.roles as string[]) : [],
        expiresAt,
        revoked: false,
      });
      issuedTokens.push(token);
      sendJson(response, 200, { token, expires: expiresAt, ssl: true });
      return;
    }

    if (route === "POST /sharing/rest/oauth2/revoke") {
      const token = new URLSearchParams(await readBody(request)).get("token") ?? "";
      const credential = credentials.get(token);
      if (credential) credential.revoked = true;
      response.writeHead(200).end();
      return;
    }

    const addFeatures = /^POST \/rest\/services\/test_service\/FeatureServer\/(\d+)\/addFeatures$/u.exec(route);
    if (addFeatures) {
      const layerId = addFeatures[1] as string;
      const credential = validCredential(tokenFrom(request, url));
      if (!credential || credential.tenant !== LAYER_TENANTS[layerId] || !credential.roles.includes("editor")) {
        sendJson(response, 403, { error: { code: 403, message: "Forbidden" } });
        return;
      }
      const form = new URLSearchParams(await readBody(request));
      const features = JSON.parse(form.get("features") ?? "[]") as { attributes: { name: string } }[];
      const addResults = features.map((feature) => ({
        objectId: publishFeature(Number(layerId), feature.attributes.name).objectId,
        success: true,
      }));
      sendJson(response, 200, { addResults, updateResults: [], deleteResults: [], success: true });
      return;
    }

    if (route === "POST /sta/v1.1/Datastreams(1)/Observations") {
      const tenant = request.headers["x-honua-tenant"];
      if (request.headers["x-api-key"] !== options.adminApiKey || typeof tenant !== "string") {
        sendJson(response, 401, { status: 401 });
        return;
      }
      const body = JSON.parse(await readBody(request)) as { result?: unknown };
      if (typeof body.result !== "number" || !Number.isFinite(body.result)) {
        sendJson(response, 400, { status: 400 });
        return;
      }
      // Ids are allocated per tenant, so two tenants' observations share ids.
      const iotId = (observationIds.get(tenant) ?? 0) + 1;
      observationIds.set(tenant, iotId);
      const observation = { iotId, tenant, result: body.result };
      for (const subscriber of observationSubscribers) subscriber(observation);
      sendJson(response, 201, { "@iot.id": iotId, datastreamId: 1, result: body.result });
      return;
    }

    if (route === "GET /api/v1/streaming/features" || route === "GET /sta/v1.1/ObservationsStream") {
      handleSse(request, response, url);
      return;
    }

    const odata = /^GET \/odata\/Features\((\d+)\)$/u.exec(route);
    if (odata) {
      const layerId = odata[1] as string;
      const credential = validCredential(tokenFrom(request, url));
      if (!credential) {
        const status = defects.odataConcealsUnauthorized ? 404 : 401;
        sendJson(response, status, { status });
        return;
      }
      if (credential.tenant !== LAYER_TENANTS[layerId]) {
        sendJson(response, 404, { error: { code: "ResourceNotFound", message: `Layer ${layerId} not found` } });
        return;
      }
      const since = Number(url.searchParams.get("$deltatoken") ?? "0");
      const upto = Number(url.searchParams.get("upto") ?? String(cursor));
      const skip = Number(url.searchParams.get("$skip") ?? "0");
      const rows = events.filter(
        (event) => event.layerId === Number(layerId) && event.cursor > since && event.cursor <= upto,
      );
      const base = `http://${request.headers.host}/odata/Features(${layerId})`;
      const page: Json = {
        "@odata.context": `${base}/$metadata#Features${since > 0 ? "/$delta" : ""}`,
        value: rows
          .slice(skip, skip + pageSize)
          .map((event) => ({ ObjectId: event.objectId, LayerId: event.layerId, name: event.name })),
      };
      if (skip + pageSize < rows.length) {
        page["@odata.nextLink"] = `${base}?$deltatoken=${since}&upto=${upto}&$skip=${skip + pageSize}`;
      } else {
        page["@odata.deltaLink"] = `${base}?$deltatoken=${upto}`;
      }
      sendJson(response, 200, page);
      return;
    }

    sendJson(response, 404, { status: 404 });
  }

  /** Shared admission for both stream transports; answers the refusal status or the admitted scope. */
  function admit(
    url: URL,
    token: string | null,
  ): { status: number; reason: string } | { credential: Credential; layerId: number | null } {
    const credential = validCredential(token);
    if (!credential) return { status: 401, reason: "Unauthorized" };
    if (url.pathname === "/sta/v1.1/ObservationsStream") {
      if (url.searchParams.has("cursor")) return { status: 400, reason: "Bad Request" };
      return { credential, layerId: null };
    }
    const layer = url.searchParams.get("layers") ?? "";
    if (credential.tenant !== LAYER_TENANTS[layer]) return { status: 403, reason: "Forbidden" };
    return { credential, layerId: Number(layer) };
  }

  /** Subscribes a transport and returns its cleanup; `emit` receives already-scoped frames. */
  function subscribe(
    url: URL,
    scope: { credential: Credential; layerId: number | null },
    emit: (event: string, frame: Json) => void,
  ) {
    if (scope.layerId === null) {
      emit("status", { status: "connected", datastreamId: 1 });
      const onObservation = (observation: Observation) => {
        if (observation.tenant === scope.credential.tenant) {
          emit("observation", { "@iot.id": observation.iotId, datastreamId: 1, result: observation.result });
        }
      };
      observationSubscribers.add(onObservation);
      return () => observationSubscribers.delete(onObservation);
    }
    emit("status", { type: "status", status: "connected" });
    emit("status", { type: "status", status: "subscribed", subscriptionId: "default" });
    const layerId = scope.layerId;
    const replayFrom = url.searchParams.get("cursor");
    if (replayFrom !== null) {
      for (const event of events) {
        if (event.layerId === layerId && event.cursor > Number(replayFrom)) emit("feature-change", featureFrame(event));
      }
    }
    const onFeature = (event: FeatureEvent) => {
      if (event.layerId === layerId || defects.leakForeignFeatures) emit("feature-change", featureFrame(event));
    };
    featureSubscribers.add(onFeature);
    return () => featureSubscribers.delete(onFeature);
  }

  function handleSse(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const token = tokenFrom(request, url);
    const scope = admit(url, token);
    if ("status" in scope) {
      sendJson(response, scope.status, { status: scope.status });
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const unsubscribe = subscribe(url, scope, (event, frame) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(frame)}\n\n`);
    });
    let stopRevalidation = () => {};
    const finish = () => {
      stopRevalidation();
      unsubscribe();
      openStreams.delete(abort);
    };
    const abort = () => {
      finish();
      response.destroy();
    };
    stopRevalidation = revalidate(token as string, () => {
      finish();
      response.end('event: status\ndata: {"status":"error","code":"authorization-ended"}\n\n');
    });
    openStreams.add(abort);
    request.on("close", finish);
  }

  const server: Server = createServer((request, response) => {
    handleHttp(request, response).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://candidate.invalid");
    if (url.pathname !== "/api/v1/streaming/features" && url.pathname !== "/sta/v1.1/ObservationsStream") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const token = tokenFrom(request, url);
    const scope = admit(url, token);
    if ("status" in scope) {
      rejectUpgrade(socket, scope.status, scope.reason);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const unsubscribe = subscribe(url, scope, (_event, frame) => webSocket.send(JSON.stringify(frame)));
      let stopRevalidation = () => {};
      const finish = () => {
        stopRevalidation();
        unsubscribe();
        openStreams.delete(abort);
      };
      const abort = () => {
        finish();
        webSocket.terminate();
      };
      stopRevalidation = revalidate(token as string, () => {
        finish();
        if (scope.layerId !== null && defects.featureWebSocketAbortsWithoutClose) webSocket.terminate();
        else webSocket.close(1008, "authorization-ended");
      });
      openStreams.add(abort);
      webSocket.on("close", finish);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    issuedTokens,
    async close() {
      for (const abort of [...openStreams]) abort();
      webSockets.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
