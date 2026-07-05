import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Loader for the vendored geospatial-mcp JSON Schemas and their index.
 *
 * The schemas are vendored under `certification/geospatial-mcp-schemas/` (see
 * that directory's `PROVENANCE.md`). Loading is filesystem-only and fully
 * deterministic — no network access and no model/API calls.
 */

export interface StandardToolEntry {
  /** Bare taxonomy.md tool name (e.g. `query_features`). */
  standardName: string;
  /** Name the reference implementation advertises, or null when unimplemented. */
  referenceToolName: string | null;
  family: string;
  /** Relative path of the schema file, e.g. `tools/query_features.schema.json`. */
  schema: string;
  implementationStatus: "implemented" | "known-gap";
  notes?: string;
}

export interface StandardResourceEntry {
  family: string;
  uriForm: string;
  schema: string;
  shapeFidelity: string;
  implementationStatus?: "implemented" | "known-gap";
  notes?: string;
}

export interface SchemaIndex {
  title: string;
  date: string;
  dialect: string;
  tools: StandardToolEntry[];
  resources: StandardResourceEntry[];
  common: { name: string; schema: string; role: string }[];
  conformance?: { name: string; schema: string; role: string }[];
}

/**
 * Reference-implementation aliasing decision (SDK-local, NOT part of the
 * vendored standard): the honua-server /mcp surface advertises
 * `honua_dry_run_plan` alongside `honua_validate_plan`, both driven by the same
 * partial-plan input schema (see the `validate_plan` entry's notes in the
 * vendored index). The vendored `index.json` is a byte-exact copy of the
 * upstream standard and must never be hand-edited to encode this, so the alias
 * lives here in code instead.
 */
export const REFERENCE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  honua_dry_run_plan: "honua_validate_plan",
};

export type JsonSchema = Record<string, unknown>;

/**
 * Resolved root of the vendored schema tree.
 *
 * The vendored schemas live at the package root under
 * `certification/geospatial-mcp-schemas/`. This module runs from two locations:
 *   - compiled: `dist/src/certification/schema-index.js` (3 levels deep)
 *   - vitest:   `src/certification/schema-index.ts` (2 levels deep)
 * so we probe candidate depths and pick the one that exists on disk.
 */
function resolveSchemaRoot(): URL {
  const candidates = ["../../../certification/geospatial-mcp-schemas/", "../../certification/geospatial-mcp-schemas/"];
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(new URL("index.json", url))) {
      return url;
    }
  }
  // Fall back to the compiled-layout path; the loader will surface a clear
  // ENOENT if the vendored schemas are genuinely missing.
  return new URL(candidates[0], import.meta.url);
}

export const SCHEMA_ROOT = resolveSchemaRoot();

let cachedIndex: SchemaIndex | undefined;
const schemaCache = new Map<string, JsonSchema>();

/** Load and cache the machine-readable schema index. */
export function loadSchemaIndex(): SchemaIndex {
  if (!cachedIndex) {
    const indexPath = new URL("index.json", SCHEMA_ROOT);
    cachedIndex = JSON.parse(readFileSync(indexPath, "utf8")) as SchemaIndex;
  }
  return cachedIndex;
}

/** Load and cache a single vendored schema by its index-relative path. */
export function loadSchemaFile(relativePath: string): JsonSchema {
  const cached = schemaCache.get(relativePath);
  if (cached) {
    return cached;
  }
  const path = new URL(relativePath, SCHEMA_ROOT);
  const schema = JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
  schemaCache.set(relativePath, schema);
  return schemaCache.get(relativePath) as JsonSchema;
}

/** Resolve the absolute on-disk path of the vendored schema root (for diagnostics). */
export function schemaRootPath(): string {
  return fileURLToPath(SCHEMA_ROOT);
}

/**
 * Build a lookup from the name a tool advertises (`referenceToolName`) to its
 * standard schema entry. Only entries that name a reference tool are included.
 * SDK-local reference aliases (see {@link REFERENCE_TOOL_ALIASES}) map extra
 * advertised names onto the same standard entry.
 */
export function buildReferenceToolLookup(index: SchemaIndex): Map<string, StandardToolEntry> {
  const lookup = new Map<string, StandardToolEntry>();
  for (const tool of index.tools) {
    if (tool.referenceToolName) {
      lookup.set(tool.referenceToolName, tool);
    }
  }
  for (const [alias, canonical] of Object.entries(REFERENCE_TOOL_ALIASES)) {
    const entry = lookup.get(canonical);
    if (entry) {
      lookup.set(alias, entry);
    }
  }
  return lookup;
}
