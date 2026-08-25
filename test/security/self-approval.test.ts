/**
 * Security eval — **self-approval** (honua-sdk-js#1425, AC "Security evals
 * reject self-approval …").
 *
 * The property under test: *the principal that proposes a change can never be
 * the principal that approves it*, on any surface an agent can reach. Approval
 * is a separate principal acting through the canonical Admin API/CLI; every
 * client-side surface in this SDK must refuse to even serialize a decision.
 *
 * This is the deterministic half of the acceptance criterion. It drives the
 * shipped clients over a recording transport and proves the refusal by the
 * **request list being empty** — a guard that fires after the bytes are on the
 * wire is not a guard. The genuine-model canary (does a real model *try* to
 * self-approve, and does it recover?) stays open on #1425; nothing here
 * substitutes for it.
 *
 * Each `it` names the property it defends and says what an attacker — or, far
 * more likely, a confused agent that has been told "just make it publish" —
 * would otherwise achieve.
 */

import { describe, expect, it } from "vitest";

import {
  HONUA_COMMANDS,
  HONUA_COMMAND_IDS,
  HONUA_COMMAND_RESERVED_HEADERS,
  HONUA_COMMAND_TRANSPORTS,
  type HonuaAnyCommand,
  type HonuaCommandJsonSchema,
  createHonuaCommandRuntime,
  isHonuaCommandError,
  serializeHonuaCommandReceipt,
} from "../../src/control-plane/index.js";
import type { HonuaMapPackage } from "../../src/runtime/index.js";
import {
  HonuaStudioLifecycleClient,
  HonuaStudioPublicationRequestsClient,
  isHonuaStudioError,
} from "../../src/studio/index.js";
import { recordingClient, wireBytes } from "./harness.js";

/**
 * Keys a publication submission may never carry.
 *
 * Deliberately re-declared here rather than imported: `REJECTED_SUBMISSION_KEYS`
 * is module-private in `src/studio/lifecycle-client.ts`, and importing the
 * implementation's own list would make this eval tautological — it would pass
 * even if someone emptied the set. This list is the *specification*, and a
 * shipped set that no longer covers it fails here.
 */
const SELF_APPROVAL_KEYS = [
  "status",
  "state",
  "approve",
  "approved",
  "approval",
  "approvedAt",
  "approvedBy",
  "autoApprove",
  "selfApprove",
  "skipApproval",
  "bypassApproval",
  "bypassPolicy",
  "policyOverride",
  "overridePolicy",
  "force",
] as const;

/** Authority headers a caller must never be able to set on a command. */
const APPROVAL_HEADERS = ["X-Honua-Approver", "X-Honua-Approved-By", "X-Honua-Policy-Decision"] as const;

const MAP_PACKAGE = { id: "pkg-eval", version: "1.0.0", layers: [] } as unknown as HonuaMapPackage;

/** A minimal valid input for each catalog command, so only the smuggled key is at fault. */
const VALID_INPUT: Readonly<Record<string, Record<string, unknown>>> = {
  "connection.test": { connectionId: "conn-1" },
  "import.create": { sourceKind: "geojson", sourceUrl: "https://data.example.test/a.geojson" },
  "map-package.publish": { package: MAP_PACKAGE },
  "studio.draft.saveVersion": { draftId: "draft-1" },
};

function studioFor(apiKey?: string) {
  const recording = recordingClient(apiKey ? { apiKey } : {});
  return {
    studio: new HonuaStudioLifecycleClient({ client: recording.client }),
    requests: recording.requests,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Surface 1 — the Studio publication proposal client
// ───────────────────────────────────────────────────────────────────────────

describe("self-approval :: Studio publication submissions", () => {
  it("refuses every self-approval key before a byte reaches the network", async () => {
    // Attacker/confused agent: appends `"approved": true` (or `"status":
    // "Active"`, or `"force": true`) to the publish-request body it was shown
    // in a skill, and the proposal skips the human approval gate entirely.
    for (const key of SELF_APPROVAL_KEYS) {
      const { studio, requests } = studioFor();
      await expect(
        studio.publicationRequests.create("item-1", "ver-1", { [key]: true, intent: { visibility: "public" } }),
      ).rejects.toSatisfy(
        (error: unknown) => isHonuaStudioError(error) && error.code === "validation" && error.statusCode === 400,
      );
      expect(requests, `submitting ${key} must issue no request`).toHaveLength(0);
    }
  });

  it("refuses them in every casing, so a rename is not a bypass", async () => {
    // Confused agent: copies `AUTOAPPROVE` from a shell transcript, or a
    // transport lower-cases keys on one path and not another. A case-sensitive
    // guard would let exactly one spelling through.
    for (const spelling of ["APPROVED", "Approved", "aPpRoVeD", "SKIPAPPROVAL", "Force"]) {
      const { studio, requests } = studioFor();
      await expect(studio.publicationRequests.create("item-1", "ver-1", { [spelling]: true })).rejects.toSatisfy(
        (error: unknown) => isHonuaStudioError(error) && error.code === "validation",
      );
      expect(requests, `${spelling} must issue no request`).toHaveLength(0);
    }
  });

  it("names the offending key and the separate-principal rule in the refusal", async () => {
    // A refusal an agent cannot act on gets retried with a different spelling.
    // The message has to say *what* was wrong and *who* is allowed to approve,
    // or the recovery behaviour the model canary grades has nothing to read.
    const { studio } = studioFor();
    const error = await studio.publicationRequests
      .create("item-1", "ver-1", { autoApprove: true })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);
    expect(isHonuaStudioError(error)).toBe(true);
    expect((error as Error).message).toContain("autoApprove");
    expect((error as Error).message).toMatch(/separate principal/i);
    expect((error as Error).message).toMatch(/Admin API\/CLI/i);
  });

  it("still accepts a legitimate submission that merely mentions approval, so agents are not driven to raw()", async () => {
    // The inverse failure: an over-broad substring guard rejects the server's
    // real additive fields (`approvalPolicyId`, `stateReason`), the agent
    // concludes the typed client is broken, and reaches for the untyped
    // `raw()` escape hatch — which has *no* client-side approval semantics at
    // all. Over-blocking here makes the system less safe, not more.
    const { studio, requests } = studioFor();
    await studio.publicationRequests.create("item-1", "ver-1", {
      approvalPolicyId: "policy-7",
      stateReason: "ready for review",
      contentHash: "sha256:abc",
      idempotencyKey: "submit-1",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toMatchObject({ approvalPolicyId: "policy-7", stateReason: "ready for review" });
  });

  it("exposes no approve, authorize, force, or override method anywhere on the Studio client tree", async () => {
    // Attacker: does not need to smuggle a field if the client hands them a
    // method. This walks every resource group on the shipped lifecycle client
    // and asserts no callable is named for a decision.
    const { studio } = studioFor();
    const decisionWord = /approve|authoriz|override|force|bypass|grant|elevate|escalate/i;
    const groups: Array<[string, object]> = [
      ["lifecycle", studio],
      ["packageFamilies", studio.packageFamilies],
      ["drafts", studio.drafts],
      ["contentItems", studio.contentItems],
      ["contentVersions", studio.contentVersions],
      ["publicationRequests", studio.publicationRequests],
      ["rollbackRequests", studio.rollbackRequests],
    ];
    for (const [label, group] of groups) {
      const names = [
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(group) as object),
        ...Object.getOwnPropertyNames(group),
      ];
      for (const name of names) {
        expect(`${label}.${name}`, `${label}.${name} reads as a decision capability`).not.toMatch(decisionWord);
      }
    }

    // And the proposal client's whole callable surface is exactly propose /
    // read / watch — no fourth verb crept in.
    expect(
      Object.getOwnPropertyNames(HonuaStudioPublicationRequestsClient.prototype)
        .filter((name) => name !== "constructor")
        .sort(),
    ).toEqual(["create", "get", "poll"]);
  });

  it("does not soften a server-side approval refusal reached through raw()", async () => {
    // Attacker: bypasses the typed client entirely and POSTs the approval
    // route through the generic escape hatch. The escape hatch must carry no
    // approval semantics of its own — the server's 403 has to surface as a
    // typed refusal, not be swallowed into a success-shaped result an agent
    // would report as "published".
    const recording = recordingClient({}, () => ({
      status: 403,
      body: { type: "about:blank", title: "Forbidden", status: 403, detail: "Approval requires a separate principal." },
    }));
    const studio = new HonuaStudioLifecycleClient({ client: recording.client });
    await expect(
      studio.raw({ method: "POST", path: "/content-items/item-1/publish-requests/req-1/approve" }),
    ).rejects.toSatisfy((error: unknown) => isHonuaStudioError(error) && error.code === "forbidden");
    expect(recording.requests).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Surface 2 — the shared application-command layer (CLI / MCP / Studio / SDK)
// ───────────────────────────────────────────────────────────────────────────

/** Every `type: "object"` node in a command schema, addressed by path. */
function objectNodes(schema: HonuaCommandJsonSchema, path = ""): Array<[string, HonuaCommandJsonSchema]> {
  const found: Array<[string, HonuaCommandJsonSchema]> = [];
  if (schema.type === "object") found.push([path, schema]);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    found.push(...objectNodes(child as HonuaCommandJsonSchema, path ? `${path}.${key}` : key));
  }
  if (schema.items) found.push(...objectNodes(schema.items as HonuaCommandJsonSchema, `${path}[]`));
  return found;
}

/**
 * The only object nodes in the catalog that are deliberately open, and why.
 *
 * Both are opaque *data* payloads forwarded verbatim to the server, not
 * authority surfaces: nothing inside them is read by the SDK to make an
 * authorization decision. A third entry appearing here is a review event, which
 * is the point of pinning the list.
 */
const DOCUMENTED_OPEN_PAYLOADS = new Set(["import.create::options", "map-package.publish::package"]);

describe("self-approval :: the shared command layer", () => {
  it("keeps every command's input schema closed, so no transport can invent an approval field", () => {
    // Attacker: finds the one transport whose schema is open, adds
    // `approve: true` there, and the shared runtime forwards it. A closed
    // schema is the single mechanism that makes "four transports, one policy"
    // true rather than aspirational.
    for (const id of HONUA_COMMAND_IDS) {
      const command = HONUA_COMMANDS[id] as HonuaAnyCommand;
      expect(command.inputSchema.additionalProperties, `${id} root schema must be closed`).toBe(false);
      for (const [path, node] of objectNodes(command.inputSchema)) {
        if (path === "") continue;
        const key = `${id}::${path}`;
        if (DOCUMENTED_OPEN_PAYLOADS.has(key)) continue;
        expect(node.additionalProperties, `${key} must be closed or documented as an opaque payload`).toBe(false);
      }
    }
  });

  it("refuses a smuggled approval field on every command from every transport, with zero requests issued", async () => {
    // Attacker/confused agent: the CLI rejects `--approve`, so they call the
    // same command over MCP (or the SDK, or Studio) hoping one surface is
    // laxer. The whole point of the shared layer is that transport choice
    // buys nothing.
    for (const id of HONUA_COMMAND_IDS) {
      for (const transport of HONUA_COMMAND_TRANSPORTS) {
        for (const key of ["approve", "autoApprove", "bypassPolicy", "force"]) {
          const recording = recordingClient({ apiKey: "caller-scoped-key" });
          const runtime = createHonuaCommandRuntime({ client: recording.client });
          const command = HONUA_COMMANDS[id] as HonuaAnyCommand;
          await expect(
            runtime.execute(command, { ...VALID_INPUT[id], [key]: true } as never, { transport }),
          ).rejects.toSatisfy((error: unknown) => isHonuaCommandError(error) && error.kind === "validation");
          expect(recording.requests, `${id}/${transport}/${key} must issue no request`).toHaveLength(0);
        }
      }
    }
  });

  it("refuses an approval-asserting header on every command from every transport, with zero requests issued", async () => {
    // Attacker: cannot put the decision in the body, so puts it in a header —
    // `X-Honua-Approver: me`. The runtime screens headers before it plans, so
    // this fails as `authorization`, not `validation`, and nothing is sent.
    for (const id of HONUA_COMMAND_IDS) {
      for (const transport of HONUA_COMMAND_TRANSPORTS) {
        for (const header of APPROVAL_HEADERS) {
          const recording = recordingClient({ apiKey: "caller-scoped-key" });
          const runtime = createHonuaCommandRuntime({ client: recording.client });
          const command = HONUA_COMMANDS[id] as HonuaAnyCommand;
          await expect(
            runtime.execute(command, VALID_INPUT[id] as never, {
              transport,
              headers: { [header]: "attacker@example.test" },
            }),
          ).rejects.toSatisfy((error: unknown) => isHonuaCommandError(error) && error.kind === "authorization");
          expect(recording.requests, `${id}/${transport}/${header} must issue no request`).toHaveLength(0);
        }
      }
    }
  });

  it("pins the reserved-header roster so a future authority header cannot be added without review", () => {
    // A header the runtime does not know about is a header a transport can
    // set. This is the roster the screen above enforces; shrinking it is the
    // regression this locks.
    expect([...HONUA_COMMAND_RESERVED_HEADERS].sort()).toEqual([
      "authorization",
      "cookie",
      "proxy-authorization",
      "x-api-key",
      "x-forwarded-access-token",
      "x-forwarded-user",
      "x-honua-act-as",
      "x-honua-actor",
      "x-honua-admin-key",
      "x-honua-api-key",
      "x-honua-approved-by",
      "x-honua-approver",
      "x-honua-impersonate",
      "x-honua-policy-decision",
      "x-honua-scope",
      "x-honua-scopes",
      "x-honua-tenant",
      "x-honua-tenant-id",
    ]);
    for (const header of APPROVAL_HEADERS) {
      expect(HONUA_COMMAND_RESERVED_HEADERS as readonly string[]).toContain(header.toLowerCase());
    }
  });

  it("stamps every receipt server-enforced and never records a caller-claimed decision", async () => {
    // Attacker: gets a receipt to *say* the action was approved, so a
    // downstream audit join or a human reading the agent's transcript believes
    // a gate was cleared. The receipt's authorization field is a constant, and
    // the claimed identity is echoed but never promoted to a decision.
    for (const transport of HONUA_COMMAND_TRANSPORTS) {
      const recording = recordingClient({ apiKey: "caller-scoped-key" }, () => ({ body: { packageId: "pkg-1" } }));
      const runtime = createHonuaCommandRuntime({ client: recording.client });
      const receipt = await runtime.execute(
        HONUA_COMMANDS["map-package.publish"] as HonuaAnyCommand,
        { package: MAP_PACKAGE } as never,
        {
          transport,
          identity: { actor: "attacker@example.test", tenantId: "acme", scopes: ["admin", "approver"] },
        },
      );
      expect(receipt.authorization).toBe("server-enforced");
      const serialized = serializeHonuaCommandReceipt(receipt);
      expect(serialized).not.toMatch(/"approved"|"approval"|"selfApprove"|"policyOverride"/i);
      // The claimed scopes are recorded as a claim, and never travel as one.
      expect(wireBytes(recording.requests)).not.toContain("approver");
      expect(wireBytes(recording.requests)).not.toContain("attacker@example.test");
    }
  });

  it("previews a publish without contacting the server, so a dry run cannot be the approval", async () => {
    // Confused agent: treats `dryRun` as "ask for permission" and then reports
    // the plan as a completed publication. A dry run must issue no request at
    // all, and the receipt must say `dry-run` rather than `ok`.
    const recording = recordingClient({ apiKey: "caller-scoped-key" });
    const runtime = createHonuaCommandRuntime({ client: recording.client });
    const receipt = await runtime.execute(
      HONUA_COMMANDS["map-package.publish"] as HonuaAnyCommand,
      { package: MAP_PACKAGE } as never,
      { transport: "mcp", dryRun: true },
    );
    expect(receipt.status).toBe("dry-run");
    expect(receipt.authorization).toBe("server-enforced");
    expect(recording.requests).toHaveLength(0);
  });
});
