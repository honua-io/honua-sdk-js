import { createHash } from "node:crypto";

import type {
  DiagnosticBodyPreview,
  DiagnosticBundleV1,
  DiagnosticEnvelope,
  DiagnosticHeader,
  DiagnosticValidationIssue,
  DiagnosticValidationResult,
} from "./types.js";

export const DIAGNOSTIC_SCHEMA_URL = "https://honua.io/schemas/diagnostic-bundle.v1.json";
export const DIAGNOSTIC_SCHEMA_SHA256 = "4dd7282d17bb417d56f1c3cfa243e03b612a401e5d22be766658849287e431a9";
export const DIAGNOSTIC_SCHEMA_BYTES = 6494;
export const DIAGNOSTIC_SCHEMA_SOURCE_COMMIT = "0c990fbe8f519a00a57e26dab21cbb8f80d559ea";

const CLASSIFICATIONS = new Set(["unknown", "public", "internal", "customer-data", "secret-suspected"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function add(issues: DiagnosticValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: DiagnosticValidationIssue[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) if (!allow.has(key)) add(issues, `${path}.${key}`, "is not allowed");
  for (const key of required) if (!Object.hasOwn(value, key)) add(issues, `${path}.${key}`, "is required");
}

function stringField(
  value: unknown,
  path: string,
  issues: DiagnosticValidationIssue[],
  maxLength: number,
  required = false,
): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string") add(issues, path, "must be a string");
  else if (value.length > maxLength) add(issues, path, `must not exceed ${maxLength} characters`);
}

function validateHeader(value: unknown, path: string, issues: DiagnosticValidationIssue[]): value is DiagnosticHeader {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  exactKeys(value, ["name", "value"], ["name", "value"], path, issues);
  stringField(value.name, `${path}.name`, issues, 128, true);
  stringField(value.value, `${path}.value`, issues, 2048, true);
  return true;
}

function validateBody(
  value: unknown,
  path: string,
  issues: DiagnosticValidationIssue[],
): value is DiagnosticBodyPreview {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  exactKeys(
    value,
    ["preview", "contentSha256", "originalByteSize", "redactionApplied", "truncated"],
    ["originalByteSize", "redactionApplied", "truncated"],
    path,
    issues,
  );
  stringField(value.preview, `${path}.preview`, issues, 8192);
  stringField(value.contentSha256, `${path}.contentSha256`, issues, 64);
  if (
    !Number.isInteger(value.originalByteSize) ||
    (value.originalByteSize as number) < 0 ||
    (value.originalByteSize as number) > 26_214_400
  ) {
    add(issues, `${path}.originalByteSize`, "must be an integer from 0 through 26214400");
  }
  if (typeof value.redactionApplied !== "boolean") add(issues, `${path}.redactionApplied`, "must be boolean");
  if (typeof value.truncated !== "boolean") add(issues, `${path}.truncated`, "must be boolean");
  return true;
}

function validateHeaders(value: unknown, path: string, issues: DiagnosticValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    add(issues, path, "must be an array");
    return;
  }
  if (value.length > 32) add(issues, path, "must contain at most 32 headers");
  value.forEach((header, index) => validateHeader(header, `${path}[${index}]`, issues));
}

function validateEnvelope(
  value: unknown,
  path: string,
  issues: DiagnosticValidationIssue[],
): value is DiagnosticEnvelope {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return false;
  }
  exactKeys(
    value,
    [
      "method",
      "normalizedPath",
      "statusCode",
      "mediaType",
      "correlationId",
      "traceId",
      "capturedAt",
      "requestHeaders",
      "responseHeaders",
      "requestBody",
      "responseBody",
    ],
    ["method", "normalizedPath"],
    path,
    issues,
  );
  stringField(value.method, `${path}.method`, issues, 16, true);
  stringField(value.normalizedPath, `${path}.normalizedPath`, issues, 2048, true);
  if (
    value.statusCode !== undefined &&
    (!Number.isInteger(value.statusCode) || (value.statusCode as number) < 100 || (value.statusCode as number) > 599)
  ) {
    add(issues, `${path}.statusCode`, "must be an integer from 100 through 599");
  }
  stringField(value.mediaType, `${path}.mediaType`, issues, 256);
  stringField(value.correlationId, `${path}.correlationId`, issues, 200);
  stringField(value.traceId, `${path}.traceId`, issues, 200);
  stringField(value.capturedAt, `${path}.capturedAt`, issues, 40);
  validateHeaders(value.requestHeaders, `${path}.requestHeaders`, issues);
  validateHeaders(value.responseHeaders, `${path}.responseHeaders`, issues);
  if (value.requestBody !== undefined) validateBody(value.requestBody, `${path}.requestBody`, issues);
  if (value.responseBody !== undefined) validateBody(value.responseBody, `${path}.responseBody`, issues);
  return true;
}

export function validateDiagnosticBundle(value: unknown): DiagnosticValidationResult {
  const issues: DiagnosticValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: "$", message: "must be an object" }] };
  exactKeys(
    value,
    ["schemaVersion", "bundleId", "contentClassification", "consent", "envelopes"],
    ["schemaVersion", "contentClassification", "consent", "envelopes"],
    "$",
    issues,
  );
  if (value.schemaVersion !== "1.0") add(issues, "$.schemaVersion", 'must equal "1.0"');
  stringField(value.bundleId, "$.bundleId", issues, 64);
  if (typeof value.contentClassification !== "string" || !CLASSIFICATIONS.has(value.contentClassification)) {
    add(issues, "$.contentClassification", "is not a supported classification");
  }
  if (!isRecord(value.consent)) add(issues, "$.consent", "must be an object");
  else {
    exactKeys(
      value.consent,
      ["redactionAcknowledged", "shareWithSupport", "grantedBy"],
      ["redactionAcknowledged", "shareWithSupport"],
      "$.consent",
      issues,
    );
    if (typeof value.consent.redactionAcknowledged !== "boolean") {
      add(issues, "$.consent.redactionAcknowledged", "must be boolean");
    }
    if (typeof value.consent.shareWithSupport !== "boolean") {
      add(issues, "$.consent.shareWithSupport", "must be boolean");
    }
    stringField(value.consent.grantedBy, "$.consent.grantedBy", issues, 256);
  }
  if (!Array.isArray(value.envelopes)) add(issues, "$.envelopes", "must be an array");
  else {
    if (value.envelopes.length < 1 || value.envelopes.length > 50) {
      add(issues, "$.envelopes", "must contain 1 through 50 envelopes");
    }
    value.envelopes.forEach((envelope, index) => validateEnvelope(envelope, `$.envelopes[${index}]`, issues));
  }
  return { valid: issues.length === 0, issues };
}

export function assertDiagnosticBundle(value: unknown): asserts value is DiagnosticBundleV1 {
  const validation = validateDiagnosticBundle(value);
  if (!validation.valid) {
    const summary = validation.issues
      .slice(0, 10)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    throw new Error(`Diagnostic bundle does not match the pinned v1 schema: ${summary}`);
  }
}

export function verifyDiagnosticSchemaBytes(bytes: Uint8Array): void {
  if (bytes.byteLength !== DIAGNOSTIC_SCHEMA_BYTES)
    throw new Error("Diagnostic schema byte count does not match the pin.");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DIAGNOSTIC_SCHEMA_SHA256) throw new Error("Diagnostic schema SHA-256 does not match the pin.");
}
