/**
 * Shared provenance contract carried by AI-generated Studio packages
 * (map, dashboard, report, app, and the stub families) regardless of which
 * surface produced them — Honua Studio/Console, an MCP client, or the QGIS
 * plugin.
 *
 * Parity goal: a package generated through MCP or QGIS records the same
 * prompt / plan / data-binding / permission / origin provenance as one
 * generated in Console, so the SDK can validate, attribute, and preview it
 * with one contract. The shape is intentionally additive and open-ended —
 * unknown fields are preserved through `[extra: string]: unknown` so a newer
 * generator never breaks an older client.
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0` and before the matching
 *   server contracts ship.
 * @module
 */

/** Canonical format string for the v1 package-provenance shape. */
export const HONUA_PACKAGE_PROVENANCE_FORMAT_V1 = "honua_package_provenance.v1" as const;

export type HonuaPackageProvenanceFormat = typeof HONUA_PACKAGE_PROVENANCE_FORMAT_V1;

/**
 * The surface that produced a package. Used to attribute generation and to
 * gate which capabilities a host may assume (e.g. QGIS-origin packages cannot
 * assume Console-only server execution).
 *
 * @experimental
 */
export type HonuaPackageOrigin = "console" | "studio" | "mcp" | "qgis" | "sdk" | (string & {});

/**
 * The natural-language prompt and any structured instructions that drove an
 * AI generation. `surface` records which client captured the prompt so MCP
 * and QGIS flows carry the same shape as Console.
 *
 * @experimental
 */
export interface HonuaPromptProvenance {
  readonly text?: string;
  readonly system?: string;
  readonly surface?: HonuaPackageOrigin;
  readonly model?: string;
  readonly capturedAt?: string;
  readonly [extra: string]: unknown;
}

/**
 * One step in the generation plan the agent followed to produce the package.
 *
 * @experimental
 */
export interface HonuaPlanStep {
  readonly id?: string;
  readonly kind?: string;
  readonly summary?: string;
  readonly toolName?: string;
  readonly status?: "planned" | "succeeded" | "failed" | "skipped" | (string & {});
  readonly [extra: string]: unknown;
}

/**
 * The plan an agent executed — an ordered list of steps plus an optional
 * free-text rationale. Mirrors what Console records so MCP/QGIS-generated
 * packages can be inspected identically.
 *
 * @experimental
 */
export interface HonuaPlanProvenance {
  readonly steps?: readonly HonuaPlanStep[];
  readonly rationale?: string;
  readonly [extra: string]: unknown;
}

/**
 * One data binding referenced by a package's provenance: which source (and
 * optionally which query/layer) the generated output reads. This duplicates
 * just enough of the per-family binding to let a validator confirm the
 * package's declared inputs without loading every family-specific spec.
 *
 * @experimental
 */
export interface HonuaProvenanceDataBinding {
  readonly sourceId: string;
  readonly title?: string;
  readonly protocol?: string;
  readonly queryId?: string;
  readonly layerId?: string;
  readonly role?: "primary" | "secondary" | "lookup" | (string & {});
  readonly [extra: string]: unknown;
}

/**
 * A single permission the package requires to render or execute. `scope`
 * names the capability (e.g. `"source:read"`, `"server:execute"`) and
 * `clientSide` records whether the SDK can satisfy it in a browser preview
 * (`true`) or whether it requires server execution (`false`).
 *
 * @experimental
 */
export interface HonuaPackagePermission {
  readonly scope: string;
  readonly resource?: string;
  readonly clientSide?: boolean;
  readonly description?: string;
  readonly [extra: string]: unknown;
}

/**
 * Provenance envelope attached to a generated package, consistently shaped
 * across Console, MCP, and QGIS. Attach it under a package's `provenance`
 * field (every family carries an open `[extra]` index signature) so the SDK
 * validator and preview helpers can read one contract.
 *
 * @experimental
 */
export interface HonuaPackageProvenance {
  readonly format: HonuaPackageProvenanceFormat;
  readonly origin: HonuaPackageOrigin;
  /** Stable id of the package this provenance describes, when known. */
  readonly packageId?: string;
  readonly generatedAt?: string;
  /** Generator/tool identifier, e.g. `"honua-mcp@1.4.0"` or `"qgis-plugin@0.3"`. */
  readonly generator?: string;
  readonly prompt?: HonuaPromptProvenance;
  readonly plan?: HonuaPlanProvenance;
  readonly dataBindings?: readonly HonuaProvenanceDataBinding[];
  readonly permissions?: readonly HonuaPackagePermission[];
  readonly [extra: string]: unknown;
}

/** A package value that may carry a {@link HonuaPackageProvenance}. */
interface MaybeProvenanced {
  readonly provenance?: unknown;
}

/**
 * Read the provenance envelope off any package value, or `undefined` when it
 * is absent or malformed. Does not throw on untrusted input.
 *
 * @experimental
 */
export function getPackageProvenance(pkg: unknown): HonuaPackageProvenance | undefined {
  if (!isRecord(pkg)) return undefined;
  const provenance = (pkg as MaybeProvenanced).provenance;
  if (!isRecord(provenance)) return undefined;
  if (provenance.format !== HONUA_PACKAGE_PROVENANCE_FORMAT_V1) return undefined;
  return provenance as unknown as HonuaPackageProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
