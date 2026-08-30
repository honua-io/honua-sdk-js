/**
 * `StudioToolCatalog` — the routing authority for server-discovered Studio
 * composition tools.
 *
 * The session used to decide "is this an MCP composition tool?" by testing the
 * model's tool name against a 15-entry literal table compiled into the SDK
 * (`HONUA_STUDIO_MCP_TOOL_NAMES`). That table drifted the moment honua-server
 * grew a lifecycle verb, and it could never describe a per-principal catalog.
 * This module replaces it: the live server's `tools/list` result is ingested
 * verbatim — exact name, title, description, input schema, output schema, and
 * annotations — and a policy decides which of those descriptors this session is
 * allowed to route and advertise.
 *
 * ## Selection is metadata-driven, never prefix-driven
 *
 * A name starting with `honua_studio_` is NOT a routing credential. Any server
 * on the other end of `POST /mcp` — including one a caller was tricked into
 * pointing at — can advertise `honua_studio_delete_everything`, and prefix
 * matching would hand it the session's draft identity, generation token, and
 * bearer credentials. Selection therefore requires one of exactly two positive
 * signals:
 *
 *  1. **Server-owned classification metadata** (preferred, and what a current
 *     honua-server actually sends). The server attaches a family/view
 *     classification to each Studio descriptor, and the session policy names the
 *     families (and optionally the views) it accepts. This is the only mechanism
 *     that can express a per-principal, server-authorized catalog.
 *  2. **An explicit configured allowlist** (fallback). Exact names, supplied by
 *     the consumer. Never a pattern, never a prefix.
 *
 * Everything else is rejected, with a recorded reason.
 *
 * ## The metadata shape
 *
 * honua-server publishes this classification as of
 * honua-io/honua-server#3695 (commit `ebb2cc6a4`, the in-server scope of
 * honua-server#3428): `McpWorkflowViewDescriptorClassifier` stamps every Studio
 * draft tool that belongs to the server-authored `setup` workflow view, in both
 * the full paginated catalog and the narrowed view projection.
 *
 * ```jsonc
 * {
 *   "name": "honua_studio_add_layer",
 *   "inputSchema": { "type": "object" },
 *   "_meta": {
 *     "honua.studio": {
 *       "family": "honua.studio.composition",  // required; matched against policy.families
 *       "view": "setup",                       // optional; matched against policy.views
 *       "revision": "setup.v1"                 // optional; advisory, surfaced on the discovery report
 *     }
 *   }
 * }
 * ```
 *
 * Two things about that payload are easy to get wrong:
 *
 *  - `view` is the **view** name, not the stage id. Every classified Studio
 *    descriptor carries `"setup"`, including the ones the server files under its
 *    `compose` and `publication` stages. A `policy.views` of `["setup"]` matches
 *    the whole live family; a policy naming stages does not.
 *  - Membership in the `setup` view is NOT itself classification. That view also
 *    contains `honua_query_features`, `honua_publish_service` and friends, and
 *    the server deliberately leaves those unclassified so this catalog never
 *    routes them into the composition plane.
 *
 * `_meta` is the canonical location (MCP's forward-compatible extension slot).
 * The same object is also read off `annotations["honua.studio"]` as an alternate
 * carrier; both are read, `_meta` wins. When neither is present the descriptor is
 * `unclassified`, and only the configured allowlist can select it — which is the
 * migration path for a server older than #3695.
 *
 * Discovery can only ever NARROW what the session routes. It cannot widen
 * server RBAC: the server still authorizes every `tools/call` independently, and
 * a descriptor the principal is not entitled to simply never appears in the
 * `tools/list` result this catalog is built from.
 *
 * @module
 */

import type { StudioAiToolDefinition } from "./ai-contract.js";
import type { McpToolDescriptor } from "./mcp-protocol.js";

/**
 * The `_meta` / `annotations` key honua-server hangs Studio classification off
 * (`McpWorkflowViewDescriptorClassifier.StudioMetadataKey`).
 */
export const HONUA_STUDIO_TOOL_METADATA_KEY = "honua.studio";

/**
 * The classification family honua-server assigns to the Studio
 * composition/lifecycle tool set
 * (`McpWorkflowViewDescriptorClassifier.StudioCompositionFamily`).
 */
export const HONUA_STUDIO_TOOL_FAMILY = "honua.studio.composition";

/**
 * The server-authored workflow view Studio descriptors are classified into
 * (`McpWorkflowViewCatalog.SetupViewName`). Provided so a consumer that wants to
 * pin `policy.views` names the view the server actually stamps rather than a
 * stage id.
 */
export const HONUA_STUDIO_TOOL_SETUP_VIEW = "setup";

/** Server-owned classification for one Studio tool descriptor. */
export interface StudioToolClassification {
  /** The server-owned tool family, e.g. `"honua.studio.composition"`. */
  readonly family?: string;
  /** The server-authored workflow view this descriptor belongs to, e.g. `"setup"`. */
  readonly view?: string;
  /** Advisory revision of the server's view definition, e.g. `"setup.v1"`. */
  readonly revision?: string;
}

/** Why a discovered descriptor was not selected for routing. */
export type StudioToolRejectionReason =
  /** The server supplied no classification and the name is not on the configured allowlist. */
  | "unclassified"
  /** Classified, but into a family this session's policy does not approve. */
  | "family"
  /** In an approved family, but not in an approved view. */
  | "view"
  /** Approved by family/view, then vetoed by the policy's `approve` predicate. */
  | "policy";

/** One descriptor this session is allowed to route, with the exact server payload retained. */
export interface StudioToolCatalogEntry {
  /** The server's descriptor, unmodified — name, title, description, schemas, annotations. */
  readonly descriptor: McpToolDescriptor;
  /** The server-owned classification, or `undefined` when the server supplied none. */
  readonly classification: StudioToolClassification | undefined;
  /** Which positive signal selected this entry. */
  readonly source: "metadata" | "allowlist";
}

/** One discovered descriptor the policy refused to route, and why. */
export interface StudioToolRejection {
  readonly name: string;
  readonly reason: StudioToolRejectionReason;
  readonly classification: StudioToolClassification | undefined;
  /** Human-readable explanation, suitable for a migration diagnostic. */
  readonly detail: string;
}

/**
 * The session's approval policy. Defaults approve the canonical
 * {@link HONUA_STUDIO_TOOL_FAMILY} in every view and allowlist nothing, which is
 * the whole live catalog against a current honua-server and nothing at all
 * against one that classifies nothing — a server older than honua-server#3695
 * routes no composition tools until a consumer configures {@link allowlist}
 * explicitly. That asymmetry is deliberate: a visible, diagnosable no-op is the
 * only safe default when the server declines to say what it is serving.
 */
export interface StudioToolPolicy {
  /**
   * Server-owned families approved for routing.
   * @default [HONUA_STUDIO_TOOL_FAMILY]
   */
  readonly families?: readonly string[];
  /**
   * Server-authored views approved for routing. When omitted, every view inside
   * an approved family is approved. When supplied, a descriptor must declare a
   * view from this list — an undeclared view is a rejection, not a pass.
   */
  readonly views?: readonly string[];
  /**
   * Exact tool names to route when the server supplied NO classification
   * metadata for them. This is the migration path for a server older than
   * honua-server#3695; it is matched by exact string equality and is never
   * interpreted as a prefix or pattern.
   * @default []
   */
  readonly allowlist?: readonly string[];
  /**
   * Tool names this consumer depends on. Any that discovery does not end up
   * routing is reported as a migration diagnostic instead of being silently
   * dropped.
   * @default HONUA_STUDIO_MCP_TOOL_NAMES
   */
  readonly required?: readonly string[];
  /** Final veto, applied only to entries family/view/allowlist already approved. */
  readonly approve?: (entry: StudioToolCatalogEntry) => boolean;
}

/**
 * The distinct server-owned classification values behind the routed set, in
 * server order.
 *
 * The server stamps a `revision` on every classified descriptor so a host can
 * tell "the same catalog, re-listed" apart from "the server's view definition
 * changed". Comparing this block across two
 * {@link StudioAgentSession.toolDiscovery} reports — the natural thing to do
 * after a `tools/list_changed` refresh — is what makes that revision actionable,
 * so it is surfaced here rather than left buried on each entry.
 *
 * All three arrays are empty when nothing was routed, and `revisions` is empty
 * when the routed entries came from an allowlist rather than from metadata.
 */
export interface StudioToolClassificationSummary {
  /** Distinct approved families across the routed entries. */
  readonly families: readonly string[];
  /** Distinct approved views across the routed entries. */
  readonly views: readonly string[];
  /** Distinct server view revisions across the routed entries. */
  readonly revisions: readonly string[];
}

/** What one discovery pass found, kept for consumer migration diagnostics. */
export interface StudioToolDiscoveryReport {
  /** Every descriptor `tools/list` returned, across all pages. */
  readonly discovered: number;
  /** Pages of `tools/list` walked. */
  readonly pages: number;
  /** Names selected for routing, in server order. */
  readonly routed: readonly string[];
  /** The server-owned classification behind {@link routed}. See {@link StudioToolClassificationSummary}. */
  readonly classification: StudioToolClassificationSummary;
  /** Discovered descriptors the policy refused, with reasons. */
  readonly rejected: readonly StudioToolRejection[];
  /** Policy-`required` names discovery did not end up routing. */
  readonly missingRequired: readonly string[];
  /** Human-readable migration guidance for everything above that needs consumer action. */
  readonly diagnostics: readonly string[];
  /** Set when discovery itself failed; the session keeps its runtime tools and retries next turn. */
  readonly errorMessage?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads the server-owned classification off a descriptor. `_meta` is canonical;
 * `annotations` is read as the alternate carrier (see the module doc). Returns
 * `undefined` — never a partially-invented default — when the server said
 * nothing, so the caller can tell "unclassified" apart from "classified into a
 * family I do not approve".
 */
export function readStudioToolClassification(descriptor: McpToolDescriptor): StudioToolClassification | undefined {
  const carriers = [asRecord(descriptor._meta), asRecord(descriptor.annotations)];
  for (const carrier of carriers) {
    const block = asRecord(carrier?.[HONUA_STUDIO_TOOL_METADATA_KEY]);
    if (!block) continue;
    const family = optionalString(block.family);
    const view = optionalString(block.view);
    const revision = optionalString(block.revision);
    if (family === undefined && view === undefined && revision === undefined) continue;
    return {
      ...(family !== undefined ? { family } : {}),
      ...(view !== undefined ? { view } : {}),
      ...(revision !== undefined ? { revision } : {}),
    };
  }
  return undefined;
}

interface Decision {
  readonly approved: boolean;
  readonly source: "metadata" | "allowlist";
  readonly reason?: StudioToolRejectionReason;
  readonly detail?: string;
}

function decide(
  descriptor: McpToolDescriptor,
  classification: StudioToolClassification | undefined,
  families: readonly string[],
  views: readonly string[] | undefined,
  allowlist: ReadonlySet<string>,
): Decision {
  if (!classification || classification.family === undefined) {
    // No server-owned classification. The ONLY remaining positive signal is an
    // exact configured allowlist entry. Deliberately no prefix test here: see
    // the module doc.
    if (allowlist.has(descriptor.name)) {
      return { approved: true, source: "allowlist" };
    }
    return {
      approved: false,
      source: "allowlist",
      reason: "unclassified",
      detail: `"${descriptor.name}" carries no server-owned "${HONUA_STUDIO_TOOL_METADATA_KEY}" family classification and is not on this session's configured allowlist, so it is not routed. A current honua-server classifies every Studio composition tool it authorizes for this principal; an unclassified descriptor is either outside that family or served by a server older than honua-server#3695, in which case add the name to \`studioTools.allowlist\` to route it.`,
    };
  }

  if (!families.includes(classification.family)) {
    return {
      approved: false,
      source: "metadata",
      reason: "family",
      detail:
        `"${descriptor.name}" is classified into family "${classification.family}", which this session's policy ` +
        `does not approve (approved: ${families.join(", ") || "none"}).`,
    };
  }

  if (views && (classification.view === undefined || !views.includes(classification.view))) {
    return {
      approved: false,
      source: "metadata",
      reason: "view",
      detail:
        `"${descriptor.name}" is in approved family "${classification.family}" but view ` +
        `"${classification.view ?? "(none declared)"}" is not approved (approved: ${views.join(", ") || "none"}).`,
    };
  }

  return { approved: true, source: "metadata" };
}

/**
 * The set of server descriptors this session routes through MCP, plus the
 * rejections and migration diagnostics from building it. Immutable — a
 * re-discovery builds a new catalog rather than mutating this one, so a turn
 * already in flight keeps a consistent view.
 */
export class StudioToolCatalog {
  readonly #entries: ReadonlyMap<string, StudioToolCatalogEntry>;
  readonly #rejections: readonly StudioToolRejection[];
  readonly #missingRequired: readonly string[];
  readonly #discovered: number;

  private constructor(
    entries: ReadonlyMap<string, StudioToolCatalogEntry>,
    rejections: readonly StudioToolRejection[],
    missingRequired: readonly string[],
    discovered: number,
  ) {
    this.#entries = entries;
    this.#rejections = rejections;
    this.#missingRequired = missingRequired;
    this.#discovered = discovered;
  }

  /** An empty catalog — routes nothing. Used before discovery has run and when it failed. */
  public static empty(): StudioToolCatalog {
    return new StudioToolCatalog(new Map(), [], [], 0);
  }

  /** Applies `policy` to the exact descriptors the server advertised. */
  public static fromDescriptors(
    descriptors: readonly McpToolDescriptor[],
    policy: StudioToolPolicy = {},
  ): StudioToolCatalog {
    const families = policy.families ?? [HONUA_STUDIO_TOOL_FAMILY];
    const views = policy.views;
    const allowlist = new Set(policy.allowlist ?? []);
    const entries = new Map<string, StudioToolCatalogEntry>();
    const rejections: StudioToolRejection[] = [];

    for (const descriptor of descriptors) {
      if (typeof descriptor?.name !== "string" || descriptor.name.length === 0) continue;
      if (entries.has(descriptor.name)) continue;
      const classification = readStudioToolClassification(descriptor);
      const decision = decide(descriptor, classification, families, views, allowlist);
      if (!decision.approved) {
        rejections.push({
          name: descriptor.name,
          reason: decision.reason ?? "policy",
          classification,
          detail: decision.detail ?? `"${descriptor.name}" was not approved by this session's policy.`,
        });
        continue;
      }
      const entry: StudioToolCatalogEntry = { descriptor, classification, source: decision.source };
      if (policy.approve && !policy.approve(entry)) {
        rejections.push({
          name: descriptor.name,
          reason: "policy",
          classification,
          detail: `"${descriptor.name}" was vetoed by this session's \`approve\` predicate.`,
        });
        continue;
      }
      entries.set(descriptor.name, entry);
    }

    const missingRequired = (policy.required ?? []).filter((name) => !entries.has(name));
    return new StudioToolCatalog(entries, rejections, missingRequired, descriptors.length);
  }

  /** True for a tool name this session routes through MCP rather than the local kit executor. */
  public has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** The exact server descriptor for a routed tool — schemas and annotations included. */
  public descriptor(name: string): McpToolDescriptor | undefined {
    return this.#entries.get(name)?.descriptor;
  }

  /** Routed names, in server order. */
  public get names(): readonly string[] {
    return [...this.#entries.keys()];
  }

  public get entries(): readonly StudioToolCatalogEntry[] {
    return [...this.#entries.values()];
  }

  public get rejections(): readonly StudioToolRejection[] {
    return this.#rejections;
  }

  public get missingRequired(): readonly string[] {
    return this.#missingRequired;
  }

  /** The distinct classification values behind the routed set, in server order. */
  public get classification(): StudioToolClassificationSummary {
    const families: string[] = [];
    const views: string[] = [];
    const revisions: string[] = [];
    const push = (into: string[], value: string | undefined): void => {
      if (value !== undefined && !into.includes(value)) into.push(value);
    };
    for (const entry of this.#entries.values()) {
      push(families, entry.classification?.family);
      push(views, entry.classification?.view);
      push(revisions, entry.classification?.revision);
    }
    return { families, views, revisions };
  }

  /**
   * The routed descriptors in the proxy's HTTP tool shape. The server's exact
   * `name`, `description`, and `inputSchema` are passed through untouched;
   * `title`/`outputSchema`/`annotations` are retained on the catalog entry (see
   * {@link descriptor}) but are not part of the proxy's wire contract
   * ({@link StudioAiToolDefinition}), which carries only the triple.
   *
   * honua-server does send `annotations` and `outputSchema` on every classified
   * Studio descriptor, so the loss is at the proxy hop, not at discovery:
   * widening this to reach the model needs honua-server's
   * `StudioAiToolDefinition` (`Features/StudioAiProxy/Domain/StudioAiChatModels.cs`)
   * to grow the fields first, which honua-server#3695 did not do. Adding them
   * here alone would only produce request fields the proxy drops.
   */
  public toolDefinitions(): readonly StudioAiToolDefinition[] {
    return this.entries.map((entry) => ({
      name: entry.descriptor.name,
      ...(entry.descriptor.description !== undefined ? { description: entry.descriptor.description } : {}),
      inputSchema: entry.descriptor.inputSchema,
    }));
  }

  /** Builds the consumer-facing report for one discovery pass. */
  public report(pages: number): StudioToolDiscoveryReport {
    const diagnostics: string[] = [];
    for (const name of this.#missingRequired) {
      const rejection = this.#rejections.find((candidate) => candidate.name === name);
      diagnostics.push(
        rejection
          ? `Required Studio tool "${name}" was discovered but not routed: ${rejection.detail}`
          : `Required Studio tool "${name}" was not advertised by the server's tools/list catalog. If the server renamed or retired it, update this consumer's \`studioTools.required\` list.`,
      );
    }
    return {
      discovered: this.#discovered,
      pages,
      routed: this.names,
      classification: this.classification,
      rejected: this.#rejections,
      missingRequired: this.#missingRequired,
      diagnostics,
    };
  }
}
