import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ContractCheck } from "./certifier.js";
import {
  type ListPage,
  checkAuthContract,
  checkFeatureRoundTrip,
  checkJobLifecycle,
  checkPaginationContract,
} from "./contracts.js";
import { type EditTarget, resolveEditTarget } from "./fixtures.js";

/**
 * Deep, stateful certification contracts (A5 provability): the mutating-tool
 * round-trip, the async job lifecycle, and query pagination. These extend the
 * read-side contracts in {@link certifier} into the parts of a real deployment
 * that were "never certified" — writes and asynchronous execution.
 *
 * Safety: mutating contracts only auto-run against the offline mock (a disposable
 * fixture). Against a live/remote target they are gated behind
 * `HONUA_MCP_CERT_ALLOW_MUTATION=1` + a caller-supplied scratch service, so a
 * scheduled cert against a shared demo never mutates real data. When a target
 * lacks the tool (e.g. the pre-P1 demo), the contract SKIPS with a loud reason
 * rather than failing — so the suite stays runnable against any revision.
 */

const MUTATION_ALLOW_ENV = "HONUA_MCP_CERT_ALLOW_MUTATION";
const EDIT_TOOL = "honua_edit_features";
const QUERY_TOOL = "honua_query_features";
const EXECUTE_TOOL = "honua_execute_plan";
const MAX_JOB_POLLS = 12;
const PAGE_LIMIT = 2;
const MAX_FEATURE_PAGES = 20;

export interface DeepContractOptions {
  client: Client;
  advertisedToolNames: Set<string>;
  /** Whether the backend is the disposable offline mock (auto-allows mutation). */
  isDisposableBackend: boolean;
  /** Open a fresh unauthenticated client (for the permission-denied case). */
  connectUnauthenticated?: (() => Promise<Client>) | undefined;
  env?: NodeJS.ProcessEnv;
}

function isTruthy(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const v = value.trim().toLowerCase();
  return v.length > 0 && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

function skip(contract: ContractCheck["contract"], target: string, detail: string): ContractCheck {
  return { contract, target, status: "skipped", detail };
}

/** Run all deep contracts, returning one ContractCheck per contract (never throws). */
export async function runDeepContracts(options: DeepContractOptions): Promise<ContractCheck[]> {
  const env = options.env ?? process.env;
  const target = resolveEditTarget(env);
  const mutationAllowed = options.isDisposableBackend || isTruthy(env[MUTATION_ALLOW_ENV]);

  return [
    await runMutatingRoundTrip(options, target, mutationAllowed),
    await runMutatingPermissionDenied(options),
    await runJobLifecycle(options, mutationAllowed),
    await runQueryPagination(options, target),
  ];
}

// ── Tool / resource helpers ────────────────────────────────────────────────

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown> | undefined;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return result;
}

async function readJsonResource(client: Client, uri: string): Promise<Record<string, unknown>> {
  const res = (await client.readResource({ uri })) as { contents?: { text?: string }[] };
  const text = res.contents?.[0]?.text;
  return typeof text === "string" ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function featureAttributes(result: ToolResult): Record<string, unknown>[] {
  const features = (result.structuredContent?.features ?? []) as { attributes?: Record<string, unknown> }[];
  return features.map((f) => f.attributes ?? {});
}

// ── Contract 1: mutating-tool insert→verify→update→verify→delete→verify ──────

async function runMutatingRoundTrip(
  options: DeepContractOptions,
  target: EditTarget,
  mutationAllowed: boolean,
): Promise<ContractCheck> {
  const contract = "mutating-round-trip" as const;
  if (!options.advertisedToolNames.has(EDIT_TOOL) || !options.advertisedToolNames.has(QUERY_TOOL)) {
    return skip(contract, EDIT_TOOL, `${EDIT_TOOL}/${QUERY_TOOL} not advertised by this surface (pre-P1 or read-only)`);
  }
  if (!mutationAllowed) {
    return skip(
      contract,
      EDIT_TOOL,
      `mutating contract disabled for this target — set ${MUTATION_ALLOW_ENV}=1 with a scratch service to certify writes`,
    );
  }

  const { client } = options;
  const marker = `cert-${randomUUID().slice(0, 8)}`;
  const updatedMarker = `${marker}-updated`;
  let objectId: number | undefined;
  try {
    const inserted = await callTool(client, EDIT_TOOL, {
      serviceId: target.serviceId,
      layerId: target.layerId,
      adds: [{ attributes: { NAME: marker } }],
    });
    const addResults = (inserted.structuredContent?.addResults ?? []) as { objectId?: number }[];
    objectId = typeof addResults[0]?.objectId === "number" ? addResults[0].objectId : undefined;

    const presentAfterInsert =
      objectId !== undefined &&
      featureAttributes(
        await callTool(client, QUERY_TOOL, {
          serviceId: target.serviceId,
          layerId: target.layerId,
          objectIds: [objectId],
        }),
      ).some((a) => Number(a.OBJECTID) === objectId);

    if (objectId !== undefined) {
      await callTool(client, EDIT_TOOL, {
        serviceId: target.serviceId,
        layerId: target.layerId,
        updates: [{ objectId, attributes: { NAME: updatedMarker } }],
      });
    }
    const attributeAfterUpdate =
      objectId === undefined
        ? undefined
        : featureAttributes(
            await callTool(client, QUERY_TOOL, {
              serviceId: target.serviceId,
              layerId: target.layerId,
              objectIds: [objectId],
            }),
          )[0]?.NAME;

    if (objectId !== undefined) {
      await callTool(client, EDIT_TOOL, { serviceId: target.serviceId, layerId: target.layerId, deletes: [objectId] });
    }
    const absentAfterDelete =
      objectId !== undefined &&
      featureAttributes(
        await callTool(client, QUERY_TOOL, {
          serviceId: target.serviceId,
          layerId: target.layerId,
          objectIds: [objectId],
        }),
      ).every((a) => Number(a.OBJECTID) !== objectId);

    const outcome = checkFeatureRoundTrip({
      insertedObjectId: objectId,
      presentAfterInsert,
      attributeAfterUpdate,
      expectedAttribute: updatedMarker,
      absentAfterDelete,
    });
    return {
      contract,
      target: EDIT_TOOL,
      status: outcome.ok ? "passed" : "failed",
      detail: outcome.ok
        ? `insert→verify→update→verify→delete→verify round-trip succeeded (objectId ${objectId})`
        : outcome.errors.join("; "),
    };
  } catch (err) {
    return {
      contract,
      target: EDIT_TOOL,
      status: "failed",
      detail: `mutating round-trip raised: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Guaranteed cleanup: remove the scratch feature even if an assertion threw.
    if (objectId !== undefined) {
      await callTool(client, EDIT_TOOL, {
        serviceId: target.serviceId,
        layerId: target.layerId,
        deletes: [objectId],
      }).catch(() => {});
    }
  }
}

// ── Contract 1b: mutating call without credentials → structured auth error ───

async function runMutatingPermissionDenied(options: DeepContractOptions): Promise<ContractCheck> {
  const contract = "mutating-permission-denied" as const;
  if (!options.advertisedToolNames.has(EDIT_TOOL)) {
    return skip(contract, EDIT_TOOL, `${EDIT_TOOL} not advertised by this surface (pre-P1)`);
  }
  if (!options.connectUnauthenticated) {
    return skip(contract, EDIT_TOOL, "target does not support an unauthenticated pass");
  }
  const target = resolveEditTarget(options.env ?? process.env);
  let unauth: Client | undefined;
  try {
    unauth = await options.connectUnauthenticated();
    // An unauthenticated write MUST be refused with a structured auth signal. If
    // the boundary holds, nothing is mutated.
    let result: ToolResult | undefined;
    try {
      result = await callTool(unauth, EDIT_TOOL, {
        serviceId: target.serviceId,
        layerId: target.layerId,
        adds: [{ attributes: { NAME: "cert-should-be-denied" } }],
      });
    } catch (err) {
      const outcome = checkAuthContract(err);
      return {
        contract,
        target: EDIT_TOOL,
        status: outcome.ok ? "passed" : "failed",
        detail: outcome.ok ? "unauthenticated write refused with a structured auth error" : outcome.errors.join("; "),
      };
    }
    if (result.isError !== true) {
      return {
        contract,
        target: EDIT_TOOL,
        status: "failed",
        detail: "unauthenticated write returned a non-error result — the write auth boundary is not enforced",
      };
    }
    const outcome = checkAuthContract(result);
    return {
      contract,
      target: EDIT_TOOL,
      status: outcome.ok ? "passed" : "failed",
      detail: outcome.ok ? "unauthenticated write refused with a structured auth error" : outcome.errors.join("; "),
    };
  } catch (err) {
    return {
      contract,
      target: EDIT_TOOL,
      status: "failed",
      detail: `permission-denied pass could not be established: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (unauth) {
      await unauth.close().catch(() => {});
    }
  }
}

// ── Contract 2: async job lifecycle execute → poll → result ──────────────────

async function runJobLifecycle(options: DeepContractOptions, mutationAllowed: boolean): Promise<ContractCheck> {
  const contract = "async-job-lifecycle" as const;
  if (!options.advertisedToolNames.has(EXECUTE_TOOL)) {
    return skip(contract, EXECUTE_TOOL, `${EXECUTE_TOOL} not advertised by this surface (pre-P1)`);
  }
  if (!mutationAllowed) {
    return skip(
      contract,
      EXECUTE_TOOL,
      `job lifecycle disabled for this target — set ${MUTATION_ALLOW_ENV}=1 to certify execution against a scratch target`,
    );
  }

  const { client } = options;
  try {
    const submitted = await callTool(client, EXECUTE_TOOL, {
      plan: { planId: "cert-plan", steps: [{ stepId: "s1", kind: "QueryFeatures" }] },
    });
    const jobId = submitted.structuredContent?.jobId;
    const initialStatus = String(submitted.structuredContent?.status ?? "Unknown");
    if (typeof jobId !== "string") {
      return { contract, target: EXECUTE_TOOL, status: "failed", detail: "execute did not return a jobId" };
    }

    const jobUri = `honua://jobs/${jobId}`;
    const polledStatuses: string[] = [];
    const progressFractions: number[] = [];
    let finalStatus = initialStatus;
    let resultUri: string | undefined;
    for (let i = 0; i < MAX_JOB_POLLS; i++) {
      const state = await readJsonResource(client, jobUri);
      const status = String(state.status ?? "Unknown");
      polledStatuses.push(status);
      const fraction = (state.progress as { fraction?: unknown } | undefined)?.fraction;
      if (typeof fraction === "number") {
        progressFractions.push(fraction);
      }
      finalStatus = status;
      if (typeof state.resultUri === "string") {
        resultUri = state.resultUri;
      }
      if (["Succeeded", "Failed", "Cancelled"].includes(status)) {
        break;
      }
    }

    let resultReady = false;
    if (resultUri) {
      const pkg = await readJsonResource(client, resultUri);
      resultReady = String(pkg.status ?? "") === "Ready";
    }

    const outcome = checkJobLifecycle({
      initialStatus,
      polledStatuses,
      progressFractions,
      finalStatus,
      resultReady,
    });
    return {
      contract,
      target: EXECUTE_TOOL,
      status: outcome.ok ? "passed" : "failed",
      detail: outcome.ok
        ? `execute→poll→result honored the state machine (${[initialStatus, ...polledStatuses].join("→")}; result ready)`
        : outcome.errors.join("; "),
    };
  } catch (err) {
    return {
      contract,
      target: EXECUTE_TOOL,
      status: "failed",
      detail: `job lifecycle raised: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Contract 3: query_features pagination (read-only, safe against any target) ─

async function runQueryPagination(options: DeepContractOptions, target: EditTarget): Promise<ContractCheck> {
  const contract = "query-pagination" as const;
  if (!options.advertisedToolNames.has(QUERY_TOOL)) {
    return skip(contract, QUERY_TOOL, `${QUERY_TOOL} not advertised by this surface`);
  }

  const { client } = options;
  try {
    const pages: ListPage[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_FEATURE_PAGES; i++) {
      const args: Record<string, unknown> = { serviceId: target.serviceId, layerId: target.layerId, limit: PAGE_LIMIT };
      if (cursor) {
        args.cursor = cursor;
      }
      const result = await callTool(client, QUERY_TOOL, args);
      const keys = featureAttributes(result).map((a) => String(a.OBJECTID));
      const nextCursor = result.structuredContent?.nextCursor;
      pages.push({ keys, nextCursor: typeof nextCursor === "string" ? nextCursor : undefined });
      if (typeof nextCursor !== "string") {
        break;
      }
      cursor = nextCursor;
    }

    const paginated = pages.length > 1 || pages[0]?.nextCursor !== undefined;
    if (!paginated) {
      return skip(
        contract,
        QUERY_TOOL,
        `surface returned a single page with no nextCursor (pagination not exercised — pre-P1 surface or fewer than ${PAGE_LIMIT} features)`,
      );
    }
    const outcome = checkPaginationContract(pages);
    return {
      contract,
      target: QUERY_TOOL,
      status: outcome.ok ? "passed" : "failed",
      detail: outcome.ok
        ? `query_features paginated across ${pages.length} pages; nextCursor honored and terminated`
        : outcome.errors.join("; "),
    };
  } catch (err) {
    return {
      contract,
      target: QUERY_TOOL,
      status: "failed",
      detail: `query pagination raised: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
