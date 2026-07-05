import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { validateAgainstSchema } from "./json-schema.js";
import { loadSchemaFile } from "./schema-index.js";

/**
 * Pure, deterministic contract-check analyzers for MCP certification.
 *
 * These operate on values already obtained from the certified surface (tool
 * results, thrown errors, paginated list responses) so they are unit-testable
 * without any transport. The certifier does the I/O; these judge the shape.
 *
 * Contracts enforced (§P0.2):
 *   - output-schema : a tool's structuredContent validates against its outputSchema.
 *   - error-shape   : invalid arguments yield an `isError` tool result carrying a
 *                     structured, actionable code (validated against the vendored
 *                     geoprocessing-error schema), never a protocol error.
 *   - auth          : unauthenticated tools/call and resources/read surface a
 *                     structured `unauthenticated` / `permission_denied` signal.
 *   - pagination    : list `nextCursor` is honored and terminates.
 */

/** Machine codes that satisfy the unauthenticated / permission-denied contract. */
export const AUTH_ERROR_CODES = ["unauthenticated", "permission_denied"] as const;

/** geoprocessing-error `kind` values that denote an authorization failure. */
export const AUTH_ERROR_KINDS = ["AuthorizationDenied", "Unauthenticated", "PermissionDenied"] as const;

let cachedErrorSchema: Record<string, unknown> | undefined;
function geoprocessingErrorSchema(): Record<string, unknown> {
  if (!cachedErrorSchema) {
    cachedErrorSchema = loadSchemaFile("common/geoprocessing-error.schema.json");
  }
  return cachedErrorSchema;
}

export interface StructuredErrorEnvelope {
  code?: string;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalize a structured error envelope out of any of the places a surface may
 * carry it: a tool result's `structuredContent`, an `McpError`'s `data`, or a
 * bare geoprocessing-error object. Returns undefined when no structure is found.
 */
export function extractStructuredError(source: unknown): StructuredErrorEnvelope | undefined {
  if (source instanceof McpError) {
    const fromData = extractStructuredError(source.data);
    if (fromData) {
      return fromData;
    }
    // A raw code may live on the error's message-less data; nothing structured.
    return undefined;
  }
  if (!isRecord(source)) {
    return undefined;
  }
  // Tool result → dig into structuredContent first.
  if (isRecord(source.structuredContent)) {
    const nested = extractStructuredError(source.structuredContent);
    if (nested) {
      return nested;
    }
  }
  const code = typeof source.code === "string" ? source.code : undefined;
  // Envelope with a nested geoprocessing-error under `error`.
  if (isRecord(source.error)) {
    return { code, error: source.error };
  }
  // The object may itself be a geoprocessing-error (has `kind` + `message`).
  if (typeof source.kind === "string" && typeof source.message === "string") {
    return { code, error: source };
  }
  if (code) {
    return { code };
  }
  return undefined;
}

export interface ContractOutcome {
  ok: boolean;
  errors: string[];
}

/** Validate a value against the vendored geoprocessing-error schema. */
export function validateGeoprocessingError(error: unknown): ContractOutcome {
  const result = validateAgainstSchema(geoprocessingErrorSchema(), error);
  return { ok: result.valid, errors: result.errors };
}

/**
 * error-shape contract: an invalid-argument tool call must return an `isError`
 * result whose structuredContent carries an actionable code and a
 * geoprocessing-error-shaped `ValidationFailed` envelope.
 */
export function checkInvalidArgsContract(result: {
  isError?: boolean;
  structuredContent?: unknown;
}): ContractOutcome {
  const errors: string[] = [];
  if (result.isError !== true) {
    errors.push("expected isError=true for an invalid-argument call (got a protocol error or a success)");
  }
  const envelope = extractStructuredError(result);
  if (!envelope) {
    errors.push("no structured error envelope found on the tool result");
    return { ok: false, errors };
  }
  if (!envelope.code || envelope.code.trim().length === 0) {
    errors.push("structured error is missing a machine-actionable `code`");
  }
  if (envelope.error === undefined) {
    errors.push("structured error is missing a geoprocessing-error envelope");
  } else {
    const validation = validateGeoprocessingError(envelope.error);
    if (!validation.ok) {
      errors.push(...validation.errors.map((e) => `geoprocessing-error: ${e}`));
    }
    const kind = isRecord(envelope.error) ? envelope.error.kind : undefined;
    if (kind !== "ValidationFailed") {
      errors.push(`expected geoprocessing-error kind "ValidationFailed", got "${String(kind)}"`);
    }
    const violations = isRecord(envelope.error) ? envelope.error.violations : undefined;
    if (!Array.isArray(violations) || violations.length === 0) {
      errors.push("expected at least one structured validation `violation`");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * auth contract: an unauthenticated call must surface a structured
 * `unauthenticated` / `permission_denied` signal — either as a code on the
 * envelope or as an AuthorizationDenied geoprocessing-error kind.
 */
export function checkAuthContract(source: unknown): ContractOutcome {
  const envelope = extractStructuredError(source);
  if (!envelope) {
    return { ok: false, errors: ["no structured error found for the unauthenticated request"] };
  }
  const code = envelope.code;
  const kind = isRecord(envelope.error) ? (envelope.error.kind as string | undefined) : undefined;
  const codeOk = typeof code === "string" && (AUTH_ERROR_CODES as readonly string[]).includes(code);
  const kindOk = typeof kind === "string" && (AUTH_ERROR_KINDS as readonly string[]).includes(kind);
  if (codeOk || kindOk) {
    return { ok: true, errors: [] };
  }
  return {
    ok: false,
    errors: [
      `expected a structured auth signal (code in [${AUTH_ERROR_CODES.join(", ")}] or kind in [${AUTH_ERROR_KINDS.join(
        ", ",
      )}]), got code="${String(code)}" kind="${String(kind)}"`,
    ],
  };
}

export interface ListPage {
  /** Distinct item identity keys observed on this page (e.g. tool names). */
  keys: string[];
  nextCursor: string | undefined;
}

/**
 * pagination contract: following `nextCursor` yields additional distinct items,
 * never repeats a cursor (terminates), and the final page has no cursor.
 */
export function checkPaginationContract(pages: ListPage[]): ContractOutcome {
  const errors: string[] = [];
  if (pages.length === 0) {
    return { ok: false, errors: ["no list pages captured"] };
  }
  const seenCursors = new Set<string>();
  const seenKeys = new Set<string>();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    for (const key of page.keys) {
      seenKeys.add(key);
    }
    const isLast = i === pages.length - 1;
    if (!isLast) {
      if (!page.nextCursor) {
        errors.push(`page ${i} is not the last page but advertised no nextCursor`);
      } else if (seenCursors.has(page.nextCursor)) {
        errors.push(`nextCursor "${page.nextCursor}" repeated — pagination does not terminate`);
      } else {
        seenCursors.add(page.nextCursor);
      }
    } else if (page.nextCursor) {
      errors.push(`final page still advertises nextCursor "${page.nextCursor}" — pagination did not terminate`);
    }
  }
  if (pages.length > 1 && seenKeys.size <= pages[0].keys.length) {
    errors.push("following nextCursor did not yield any additional distinct items");
  }
  return { ok: errors.length === 0, errors };
}
