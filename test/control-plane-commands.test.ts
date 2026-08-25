import { afterEach, describe, expect, it, vi } from "vitest";

import { mapPublishInvocation } from "../src/cli/commands/map.js";
import { run } from "../src/cli/main.js";
import {
  HONUA_COMMANDS,
  HONUA_COMMAND_IDS,
  HONUA_COMMAND_RESERVED_HEADERS,
  HonuaCommandError,
  type HonuaCommandReceipt,
  connectionTestCommand,
  createHonuaCommandRuntime,
  honuaCommandAuditKey,
  importCreateCommand,
  isHonuaCommandId,
  mapPackagePublishCommand,
  serializeHonuaCommandReceipt,
  studioDraftSaveVersionCommand,
} from "../src/control-plane/index.js";
import { HonuaClient } from "../src/index.js";
import type { HonuaMapPackage } from "../src/runtime/index.js";
import { HonuaStudioLifecycleClient } from "../src/studio/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const MAP_PACKAGE = { id: "pkg-ops", version: "1.0.0", layers: [] } as unknown as HonuaMapPackage;

const PUBLISH_RESPONSE = {
  packageId: "pkg-ops-42",
  etag: 'W/"7"',
  links: { self: "/api/v1/admin/packages/pkg-ops-42" },
};

/** A recording transport; every test drives the real clients over this. */
function recorder(
  respond: (request: CapturedRequest) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  } = () => ({
    body: PUBLISH_RESPONSE,
  }),
): { requests: CapturedRequest[]; fetchFn: typeof fetch } {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(headersToRecord(init?.headers))) {
      headers[name.toLowerCase()] = value;
    }
    const request: CapturedRequest = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const reply = respond(request);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function runtimeFor(fetchFn: typeof fetch, options: { studio?: boolean } = {}) {
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  return createHonuaCommandRuntime({
    client,
    ...(options.studio ? { studio: new HonuaStudioLifecycleClient({ client }) } : {}),
  });
}

function capture(): string[] {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  return output;
}

describe("control-plane command registry", () => {
  it("registers every catalog command under its own id with a closed input schema", () => {
    expect([...HONUA_COMMAND_IDS]).toEqual([
      "connection.test",
      "import.create",
      "map-package.publish",
      "studio.draft.saveVersion",
    ]);
    for (const id of HONUA_COMMAND_IDS) {
      const command = HONUA_COMMANDS[id];
      expect(command.id).toBe(id);
      expect(command.mode).toBe("action");
      // Closed schemas are what stop one transport from growing a field
      // (an approval, an actor override) the others do not have.
      expect(command.inputSchema.additionalProperties).toBe(false);
      expect(command.inputSchema.type).toBe("object");
    }
    expect(isHonuaCommandId("map-package.publish")).toBe(true);
    expect(isHonuaCommandId("map-package.approve")).toBe(false);
  });
});

describe("command receipts", () => {
  it("threads Idempotency-Key and If-Match onto the request and echoes identity onto the receipt", async () => {
    const { requests, fetchFn } = recorder();
    const receipt = await runtimeFor(fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", workspaceId: "ws-1", package: MAP_PACKAGE },
      { transport: "sdk", identity: { actor: "user-1", tenantId: "acme", scopes: ["maps:write"] }, ifMatch: 'W/"6"' },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].path).toBe("/api/v1/admin/packages");
    expect(requests[0].headers["idempotency-key"]).toBe(receipt.idempotencyKey);
    expect(requests[0].headers["if-match"]).toBe('W/"6"');

    expect(receipt.kind).toBe("honua.command.receipt.v1");
    expect(receipt.status).toBe("ok");
    expect(receipt.identity).toEqual({ actor: "user-1", tenantId: "acme", scopes: ["maps:write"] });
    expect(receipt.resourceRef).toEqual({
      type: "map-package",
      id: "pkg-ops-42",
      workspaceId: "ws-1",
      href: "/api/v1/admin/packages/pkg-ops-42",
    });
    expect(receipt.validators).toEqual({ etag: 'W/"7"' });
    expect(receipt.authorization).toBe("server-enforced");
  });

  it("derives a stable idempotency key and audit key from the command, input, and tenant", async () => {
    const first = await runtimeFor(recorder().fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", package: MAP_PACKAGE },
      { transport: "sdk", identity: { tenantId: "acme" } },
    );
    const second = await runtimeFor(recorder().fetchFn).execute(
      mapPackagePublishCommand,
      // Same logical input, different key order.
      { package: MAP_PACKAGE, mapId: "map-ops" },
      { transport: "sdk", identity: { tenantId: "acme" } },
    );
    const otherTenant = await runtimeFor(recorder().fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", package: MAP_PACKAGE },
      { transport: "sdk", identity: { tenantId: "globex" } },
    );

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.correlationId).toBe(first.correlationId);
    expect(serializeHonuaCommandReceipt(second)).toBe(serializeHonuaCommandReceipt(first));
    expect(otherTenant.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(honuaCommandAuditKey(first)).toBe(first.auditKey);
  });

  it("previews an action without contacting the server on dry run", async () => {
    const { requests, fetchFn } = recorder();
    const receipt = await runtimeFor(fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", package: MAP_PACKAGE },
      { transport: "mcp", dryRun: true },
    );
    expect(requests).toHaveLength(0);
    expect(receipt.status).toBe("dry-run");
    expect(receipt.plan).toEqual({
      method: "POST",
      path: "/packages",
      summary: "Publish a package version for map map-ops",
      resourceRef: { type: "map-package" },
    });
    expect(receipt.output).toBeUndefined();
  });
});

describe("command error taxonomy", () => {
  it("rejects input the schema does not allow before any request is made", async () => {
    const { requests, fetchFn } = recorder();
    const error = await runtimeFor(fetchFn)
      .execute(importCreateCommand, { sourceKind: "" } as never, { transport: "sdk" })
      .catch((thrown: unknown) => thrown);
    expect(requests).toHaveLength(0);
    expect(error).toBeInstanceOf(HonuaCommandError);
    expect((error as HonuaCommandError).kind).toBe("validation");
    expect((error as HonuaCommandError).retryable).toBe(false);
    expect((error as HonuaCommandError).toJSON()).toMatchObject({
      kind: "honua.command.error.v1",
      errorKind: "validation",
      commandId: "import.create",
    });
  });

  it("classifies HTTP failures into the shared taxonomy", async () => {
    const cases = [
      { status: 403, kind: "authorization" },
      { status: 409, kind: "conflict" },
      { status: 400, kind: "validation" },
      { status: 503, kind: "transport" },
    ] as const;
    for (const scenario of cases) {
      const { fetchFn } = recorder(() => ({ status: scenario.status, body: { title: "nope" } }));
      const error = await runtimeFor(fetchFn)
        .execute(
          importCreateCommand,
          { sourceKind: "geojson", sourceUrl: "https://example.test/a.geojson" },
          { transport: "cli" },
        )
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(HonuaCommandError);
      expect((error as HonuaCommandError).kind).toBe(scenario.kind);
      expect((error as HonuaCommandError).statusCode).toBe(scenario.status);
    }
  });

  it("surfaces an aborted signal as a cancelled command error", async () => {
    const controller = new AbortController();
    const { fetchFn } = recorder(() => {
      controller.abort();
      return { body: PUBLISH_RESPONSE };
    });
    const error = await runtimeFor(fetchFn)
      .execute(mapPackagePublishCommand, { package: MAP_PACKAGE }, { transport: "sdk", signal: controller.signal })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HonuaCommandError);
    expect((error as HonuaCommandError).kind).toBe("cancelled");

    const preAborted = AbortSignal.abort();
    const early = await runtimeFor(recorder().fetchFn)
      .execute(mapPackagePublishCommand, { package: MAP_PACKAGE }, { transport: "sdk", signal: preAborted })
      .catch((thrown: unknown) => thrown);
    expect((early as HonuaCommandError).kind).toBe("cancelled");
  });

  it("owns Studio optimistic-concurrency sequencing so no transport reimplements it", async () => {
    const { requests, fetchFn } = recorder((request) =>
      request.method === "GET"
        ? { body: { success: true, data: { draftId: "draft-1", generation: 9 } } }
        : { body: { success: true, data: { versionId: "ver-1", itemId: "item-1", versionNumber: 3 } } },
    );
    const runtime = runtimeFor(fetchFn, { studio: true });

    const conflict = await runtime
      .execute(studioDraftSaveVersionCommand, { draftId: "draft-1", generation: 7 }, { transport: "studio" })
      .catch((thrown: unknown) => thrown);
    expect((conflict as HonuaCommandError).kind).toBe("conflict");
    expect(requests.map((request) => request.method)).toEqual(["GET"]);

    const receipt = await runtime.execute(
      studioDraftSaveVersionCommand,
      { draftId: "draft-1", generation: 9 },
      { transport: "studio" },
    );
    expect(receipt.status).toBe("ok");
    expect(receipt.resourceRef).toEqual({ type: "studio-content-version", id: "ver-1" });
    expect(requests.at(-1)?.path).toBe("/api/v1/studio/package-drafts/draft-1/content-versions");
    // The idempotency key rides the mutating call, not the concurrency read.
    expect(requests.at(-1)?.headers["idempotency-key"]).toBe(receipt.idempotencyKey);
    expect(requests.at(-2)?.headers["idempotency-key"]).toBeUndefined();
  });

  it("reports a missing Studio client as a transport failure rather than reaching for another credential", async () => {
    const error = await runtimeFor(recorder().fetchFn)
      .execute(studioDraftSaveVersionCommand, { draftId: "draft-1" }, { transport: "sdk" })
      .catch((thrown: unknown) => thrown);
    expect((error as HonuaCommandError).kind).toBe("transport");
  });

  it("records a durable server refusal as a denied receipt, not an error", async () => {
    const { fetchFn } = recorder(() => ({ body: { ok: false, detail: "host unreachable" } }));
    const receipt = await runtimeFor(fetchFn).execute(
      connectionTestCommand,
      { connectionId: "conn-1" },
      { transport: "cli" },
    );
    expect(receipt.status).toBe("denied");
    expect(receipt.resourceRef).toEqual({ type: "connection", id: "conn-1" });
  });
});

describe("transports adapt input and output only", () => {
  it("produces the same receipt from a CLI-shaped call and a direct JS call", async () => {
    const packageJson = JSON.stringify(MAP_PACKAGE);

    // 1. The CLI path: parse argv, dispatch through `run`, read the receipt off stdout.
    const cli = recorder();
    vi.stubGlobal("fetch", cli.fetchFn);
    const output = capture();
    const exitCode = await run([
      "map",
      "publish",
      "map-ops",
      "--package",
      packageJson,
      "--workspace",
      "ws-1",
      "--message",
      "ship it",
      "--actor",
      "user-1",
      "--tenant",
      "acme",
      "--yes",
      "--json",
      "--base-url",
      "https://example.test",
    ]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);
    const cliReceipt = JSON.parse(output.join("")) as HonuaCommandReceipt;

    // 2. The direct JS path: the same command, the same input, no CLI involved.
    const js = recorder();
    const jsReceipt = await runtimeFor(js.fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", workspaceId: "ws-1", package: MAP_PACKAGE, message: "ship it" },
      { transport: "sdk", identity: { actor: "user-1", tenantId: "acme" } },
    );

    // The transport is recorded and is the *only* difference; everything a
    // server-side audit join needs is identical, including the join key itself.
    expect(cliReceipt.transport).toBe("cli");
    expect(jsReceipt.transport).toBe("sdk");
    expect(cliReceipt.auditKey).toBe(jsReceipt.auditKey);
    expect({ ...cliReceipt, transport: undefined }).toEqual({ ...jsReceipt, transport: undefined });

    // And both put the same bytes on the wire.
    expect(cli.requests[0].method).toBe(js.requests[0].method);
    expect(cli.requests[0].path).toBe(js.requests[0].path);
    expect(cli.requests[0].body).toEqual(js.requests[0].body);
    expect(cli.requests[0].headers["idempotency-key"]).toBe(js.requests[0].headers["idempotency-key"]);
  });

  it("adapts CLI flags into exactly the input and invocation a JS caller would pass", () => {
    const { input, invocation } = mapPublishInvocation({
      positionals: ["map-ops"],
      flags: {
        package: JSON.stringify(MAP_PACKAGE),
        workspace: "ws-1",
        message: "ship it",
        "if-match": 'W/"6"',
        "idempotency-key": "key-explicit",
        "dry-run": true,
      },
    });
    expect(input).toEqual({ mapId: "map-ops", workspaceId: "ws-1", message: "ship it", package: MAP_PACKAGE });
    expect(invocation).toEqual({
      transport: "cli",
      idempotencyKey: "key-explicit",
      ifMatch: 'W/"6"',
      dryRun: true,
    });
  });
});

describe("no shared administrator credential and no client-side authorization bypass", () => {
  it("refuses caller-supplied credential and authority headers on every transport", async () => {
    for (const transport of ["cli", "mcp", "studio", "sdk"] as const) {
      for (const header of ["Authorization", "X-Honua-Admin-Key", "X-Honua-Actor", "X-Honua-Approved-By"]) {
        const { requests, fetchFn } = recorder();
        const error = await runtimeFor(fetchFn)
          .execute(
            mapPackagePublishCommand,
            { mapId: "map-ops", package: MAP_PACKAGE },
            { transport, headers: { [header]: "forged" } },
          )
          .catch((thrown: unknown) => thrown);
        expect(error, `${transport} / ${header}`).toBeInstanceOf(HonuaCommandError);
        expect((error as HonuaCommandError).kind, `${transport} / ${header}`).toBe("authorization");
        // The refusal happens before anything reaches the network.
        expect(requests, `${transport} / ${header}`).toHaveLength(0);
      }
    }
    expect(HONUA_COMMAND_RESERVED_HEADERS).toContain("x-honua-approved-by");
  });

  it("cannot approve its own publication by selecting another transport", async () => {
    // 1. The shared command declares no approval field, and its schema is
    //    closed — so an approval attempt is rejected before any request, from
    //    every transport, with the same typed error.
    for (const transport of ["cli", "mcp", "studio", "sdk"] as const) {
      const { requests, fetchFn } = recorder();
      const attempt = await runtimeFor(fetchFn)
        .execute(
          mapPackagePublishCommand,
          { mapId: "map-ops", package: MAP_PACKAGE, approvedBy: "self", approved: true } as never,
          { transport },
        )
        .catch((thrown: unknown) => thrown);
      expect(attempt, transport).toBeInstanceOf(HonuaCommandError);
      const error = attempt as HonuaCommandError;
      expect(error.kind, transport).toBe("validation");
      expect(error.issues?.map((issue) => issue.path).sort(), transport).toEqual(["approved", "approvedBy"]);
      expect(requests, transport).toHaveLength(0);
    }

    // 2. The CLI cannot even express one: its adapter projects flags onto the
    //    command's declared properties and nothing else, and it has no header
    //    pass-through to smuggle an approver claim through.
    const { input, invocation } = mapPublishInvocation({
      positionals: ["map-ops"],
      flags: {
        package: JSON.stringify(MAP_PACKAGE),
        approve: true,
        "approved-by": "self",
        header: ["X-Honua-Approver=self"],
      },
    });
    const declared = Object.keys(mapPackagePublishCommand.inputSchema.properties ?? {});
    expect(Object.keys(input).every((key) => declared.includes(key))).toBe(true);
    expect(invocation.headers).toBeUndefined();

    // 3. And a successful publication still records the decision as the
    //    server's, never the caller's.
    const receipt = await runtimeFor(recorder().fetchFn).execute(mapPackagePublishCommand, input, invocation);
    expect(receipt.authorization).toBe("server-enforced");
  });

  it("never places the claimed identity or a second credential on the wire", async () => {
    const { requests, fetchFn } = recorder();
    const receipt = await runtimeFor(fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", package: MAP_PACKAGE },
      { transport: "mcp", identity: { actor: "user-1", tenantId: "acme", scopes: ["maps:admin"] } },
    );
    const sent = Object.keys(requests[0].headers);
    for (const reserved of HONUA_COMMAND_RESERVED_HEADERS) {
      expect(sent, reserved).not.toContain(reserved);
    }
    expect(JSON.stringify(requests[0].body)).not.toContain("user-1");
    // The claim survives only as an echo on the receipt.
    expect(receipt.identity.actor).toBe("user-1");
    expect(receipt.authorization).toBe("server-enforced");
  });
});
