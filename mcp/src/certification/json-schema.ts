import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, AnySchemaObject, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import draft07MetaSchema from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
import type { JsonSchema } from "./schema-index.js";

/**
 * Deterministic JSON Schema utilities for certification.
 *
 * Two dialects appear in practice:
 *   - The vendored geospatial-mcp standard schemas declare draft 2020-12.
 *   - MCP tool `inputSchema`s emitted via zod-to-json-schema declare draft-07.
 *
 * A single Ajv 2020-12 core handles both: we register the draft-07 meta-schema
 * so a schema that declares `$schema: ".../draft-07/schema#"` resolves instead
 * of erroring with "no schema with key/ref". All work is in-process: no network
 * access, no model calls.
 *
 * `strict: false` tolerates non-standard annotation keywords (e.g.
 * `x-honua-reference-shape`); `validateFormats: false` keeps well-formedness
 * purely structural and offline.
 */
function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addMetaSchema(draft07MetaSchema as AnySchemaObject);
  return ajv;
}

export interface WellFormedResult {
  wellFormed: boolean;
  errors: string[];
}

/**
 * Check that a value is a structurally well-formed JSON Schema by asking Ajv to
 * compile it. A schema that compiles is usable as a validator; a schema Ajv
 * refuses to compile is malformed.
 */
export function checkWellFormed(schema: unknown): WellFormedResult {
  if (schema === undefined || schema === null) {
    return { wellFormed: false, errors: ["schema is missing (null/undefined)"] };
  }
  if (typeof schema !== "object") {
    return { wellFormed: false, errors: [`schema must be an object, got ${typeof schema}`] };
  }
  try {
    const ajv = createAjv();
    ajv.compile(schema as AnySchema);
    return { wellFormed: true, errors: [] };
  } catch (err) {
    return { wellFormed: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) {
    return [];
  }
  return errors.map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim());
}

/** Compile a schema into a reusable validator, or throw a descriptive error. */
export function compileValidator(schema: JsonSchema): ValidateFunction {
  const ajv = createAjv();
  return ajv.compile(schema);
}

/** Validate a value against a JSON Schema and collect human-readable errors. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): ValidationResult {
  try {
    const validate = compileValidator(schema);
    const valid = validate(value) as boolean;
    return { valid, errors: valid ? [] : formatErrors(validate.errors) };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/**
 * Extract the top-level property names a JSON Schema accepts, when discoverable
 * from a plain `type: object` shape. Returns undefined when the property set is
 * not statically enumerable (e.g. additionalProperties / combinators only).
 */
function objectPropertyNames(schema: JsonSchema): Set<string> | undefined {
  const props = schema.properties;
  if (props && typeof props === "object") {
    return new Set(Object.keys(props as Record<string, unknown>));
  }
  return undefined;
}

function requiredPropertyNames(schema: JsonSchema): string[] {
  const required = schema.required;
  return Array.isArray(required) ? (required.filter((r) => typeof r === "string") as string[]) : [];
}

/** Normalize a JSON Schema `type` (string or array) into a set. */
function schemaTypes(schema: JsonSchema | undefined): Set<string> {
  if (!schema) {
    return new Set();
  }
  const t = schema.type;
  if (typeof t === "string") {
    return new Set([t]);
  }
  if (Array.isArray(t)) {
    return new Set(t.filter((x): x is string => typeof x === "string"));
  }
  return new Set();
}

export interface ConformanceResult {
  conformant: boolean;
  /** Required standard properties the advertised schema honors. */
  matchedRequired: string[];
  /** Conformance violations (missing or type-incompatible required properties). */
  violations: string[];
  /** Non-fatal observations (e.g. advertised extra properties, type widenings). */
  notes: string[];
}

export interface ConformanceOptions {
  /**
   * Required standard properties this surface is permitted to omit because it is
   * a documented, platform-gated degradation of the tool (see the SDK-local
   * `PLATFORM_FREE_DEGRADATIONS` registry in `schema-index.ts`).
   *
   * A property listed here is a platform *binding* — an identifier that only has
   * meaning against a Honua publishing/authoring surface (e.g. `apply_style_preset`
   * requires `serviceId`+`layerId` to bind a preset onto a *published* layer via
   * the server OGC API – Styles authoring surface, ADR-0048). A platform-free
   * target has no such surface, so it degrades the tool to a non-error, client-side
   * projection keyed on the taxonomy essence alone (e.g. `styleId`) and legitimately
   * omits the binding identifiers.
   *
   * When a required standard property is absent AND listed here, it is recorded as
   * a degradation note rather than a conformance violation. Everything else stays
   * strict: unlisted required properties still fail, and type incompatibilities on
   * properties the surface DOES advertise remain violations — degradation relaxes
   * platform binding, never correctness on what is accepted.
   */
  shedRequired?: readonly string[];
}

/**
 * Deterministically compare an advertised tool inputSchema against a standard
 * geospatial-mcp tool schema.
 *
 * Conformance contract (intentionally permissive to avoid false negatives — we
 * fail only on demonstrable non-conformance, never on the absence of a tool):
 *
 *   1. Every property the standard marks `required` MUST be present in the
 *      advertised schema's properties (a client that follows the standard will
 *      send it, so the tool must accept it).
 *   2. For each such required property, when both schemas declare a `type`, the
 *      advertised type must be compatible (equal, or a superset, or `integer`
 *      accepted where the standard says `number`).
 *
 * Extra advertised properties and looser-but-compatible types are recorded as
 * notes, not violations: a richer reference shape is allowed to extend the
 * bare standard.
 */
export function checkConformance(
  advertised: JsonSchema,
  standard: JsonSchema,
  options: ConformanceOptions = {},
): ConformanceResult {
  const violations: string[] = [];
  const notes: string[] = [];
  const matchedRequired: string[] = [];

  // Required standard properties this surface may legitimately shed as a
  // documented platform-gated degradation. See {@link ConformanceOptions.shedRequired}.
  const shedRequired = new Set(options.shedRequired ?? []);

  const standardRequired = requiredPropertyNames(standard);
  const standardProps = (standard.properties ?? {}) as Record<string, JsonSchema>;
  const advertisedProps = (advertised.properties ?? {}) as Record<string, JsonSchema>;
  const advertisedNames = objectPropertyNames(advertised);

  for (const name of standardRequired) {
    const present = advertisedNames ? advertisedNames.has(name) : name in advertisedProps;
    if (!present) {
      if (shedRequired.has(name)) {
        notes.push(
          `degrades platform binding: omits required "${name}" (platform-free target has no publishing surface)`,
        );
      } else {
        violations.push(`missing required standard property "${name}"`);
      }
      continue;
    }

    const standardTypes = schemaTypes(standardProps[name]);
    const advertisedTypes = schemaTypes(advertisedProps[name]);
    if (standardTypes.size > 0 && advertisedTypes.size > 0) {
      const compatible = [...standardTypes].every((st) => {
        if (advertisedTypes.has(st)) {
          return true;
        }
        // `integer` is a refinement of `number`: a standard `number` is
        // satisfied by an advertised `integer`, and vice versa is acceptable.
        if (st === "number" && advertisedTypes.has("integer")) {
          return true;
        }
        if (st === "integer" && advertisedTypes.has("number")) {
          notes.push(`property "${name}" widens standard integer to number`);
          return true;
        }
        return false;
      });
      if (!compatible) {
        violations.push(
          `property "${name}" type ${[...advertisedTypes].join("|")} is incompatible with standard ${[...standardTypes].join("|")}`,
        );
        continue;
      }
    }
    matchedRequired.push(name);
  }

  // Record advertised-only properties as informational coverage notes.
  if (advertisedNames) {
    const standardNames = new Set(Object.keys(standardProps));
    for (const name of advertisedNames) {
      if (!standardNames.has(name)) {
        notes.push(`advertises non-standard property "${name}"`);
      }
    }
  }

  return { conformant: violations.length === 0, matchedRequired, violations, notes };
}
