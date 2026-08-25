/**
 * Structural validation for command inputs.
 *
 * Commands describe their input with the JSON-Schema subset in `./types.js`,
 * the same dialect `src/agent-tools/index.ts` uses for agent tool definitions.
 * That one description drives CLI argument checking, MCP tool schemas, Studio
 * forms, and this validator — so an input rejected by one transport is
 * rejected identically by all of them.
 *
 * The validator covers exactly the keywords the dialect declares. It is not a
 * general JSON-Schema implementation and deliberately adds no dependency;
 * `src/` is zod-free.
 *
 * @experimental
 * @module
 */

import type { HonuaCommandValidationIssue } from "./errors.js";
import type { HonuaCommandJsonSchema } from "./types.js";

/**
 * Validate `value` against `schema`, returning every finding.
 *
 * `additionalProperties: false` is the load-bearing rule for the security
 * contract: a closed input schema is why no transport can smuggle an approval
 * or authority field into a shared command.
 */
export function validateCommandInput(schema: HonuaCommandJsonSchema, value: unknown): HonuaCommandValidationIssue[] {
  const issues: HonuaCommandValidationIssue[] = [];
  validateNode(schema, value, "", issues);
  return issues;
}

function validateNode(
  schema: HonuaCommandJsonSchema,
  value: unknown,
  path: string,
  issues: HonuaCommandValidationIssue[],
): void {
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    issues.push({ path, message: `expected type ${formatType(schema.type)}, received ${describe(value)}` });
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    issues.push({ path, message: `expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}` });
    return;
  }
  if (typeof value === "string") validateString(schema, value, path, issues);
  if (typeof value === "number") validateNumber(schema, value, path, issues);
  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((entry, index) =>
        validateNode(schema.items as HonuaCommandJsonSchema, entry, `${path}[${index}]`, issues),
      );
    }
    return;
  }
  if (isPlainRecord(value)) validateObject(schema, value, path, issues);
}

function validateString(
  schema: HonuaCommandJsonSchema,
  value: string,
  path: string,
  issues: HonuaCommandValidationIssue[],
): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push({ path, message: `expected at least ${schema.minLength} character(s)` });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    issues.push({ path, message: `expected at most ${schema.maxLength} character(s)` });
  }
}

function validateNumber(
  schema: HonuaCommandJsonSchema,
  value: number,
  path: string,
  issues: HonuaCommandValidationIssue[],
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    issues.push({ path, message: `expected >= ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    issues.push({ path, message: `expected <= ${schema.maximum}` });
  }
}

function validateObject(
  schema: HonuaCommandJsonSchema,
  value: Record<string, unknown>,
  path: string,
  issues: HonuaCommandValidationIssue[],
): void {
  const properties = schema.properties ?? {};
  for (const required of schema.required ?? []) {
    if (value[required] === undefined) {
      issues.push({ path: join(path, required), message: "is required" });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const propertySchema = properties[key];
    if (propertySchema) {
      validateNode(propertySchema, child, join(path, key), issues);
      continue;
    }
    if (schema.additionalProperties === false) {
      issues.push({ path: join(path, key), message: "is not an accepted property of this command" });
      continue;
    }
    if (typeof schema.additionalProperties === "object") {
      validateNode(schema.additionalProperties, child, join(path, key), issues);
    }
  }
}

function matchesType(type: string | readonly string[], value: unknown): boolean {
  const types = typeof type === "string" ? [type] : type;
  return types.some((entry) => matchesSingleType(entry, value));
}

function matchesSingleType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainRecord(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function formatType(type: string | readonly string[]): string {
  return typeof type === "string" ? type : type.join(" | ");
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
