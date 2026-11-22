/** Supported governed warehouse providers. BigQuery and CARTO SQL API are excluded. */
export const GOVERNED_WAREHOUSE_PROVIDERS = ["redshift", "snowflake", "databricks", "duckdb"] as const;

export type GovernedWarehouseProvider = (typeof GOVERNED_WAREHOUSE_PROVIDERS)[number];

export type HonuaWarehouseErrorCode =
  | "unsupported-provider"
  | "invalid-descriptor"
  | "secret-detected"
  | "source-unavailable"
  | "plan-invalid"
  | "plan-rejected"
  | "budget-exceeded"
  | "schema-drift"
  | "corrupt-batch"
  | "handoff-refused";

/** Typed failure across governed warehouse discovery, planning, and columnar streaming. */
export class HonuaWarehouseError extends Error {
  public constructor(
    public readonly code: HonuaWarehouseErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HonuaWarehouseError";
  }
}

const PROVIDER_SET: ReadonlySet<string> = new Set(GOVERNED_WAREHOUSE_PROVIDERS);

const SENSITIVE_KEY_PATTERN =
  /^(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|connection[-_]?string|dsn|credentials?|authorization|cookie|sas[-_]?token|client[-_]?secret|oauth[-_]?token|session[-_]?token|refresh[-_]?token|signing[-_]?key|webhook[-_]?secret)$/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:AccountKey|SharedAccessSignature|Password|Pwd)\s*=/i,
  /[?&](?:sig|signature|token|access_token|api_key|x-amz-signature|x-amz-credential)=/i,
  /\b(?:postgres(?:ql)?|snowflake|redshift|databricks|jdbc:[a-z0-9]+):\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const RAW_SQL_STATEMENT_PATTERN =
  /\b(?:select\b[\s\S]*\bfrom\b|insert\s+into\b|update\s+\S+\s+set\b|delete\s+from\b|drop\s+(?:table|view|schema)\b|alter\s+table\b)/i;

const MAX_SCAN_DEPTH = 16;

export function isGovernedWarehouseProvider(value: unknown): value is GovernedWarehouseProvider {
  return typeof value === "string" && PROVIDER_SET.has(value);
}

/** Rejects any credential-shaped keys or values so browser descriptors/plans remain secret-free. */
export function assertNoWarehouseSecrets(value: unknown, path = "$", depth = 0): void {
  if (depth > MAX_SCAN_DEPTH) {
    throw new HonuaWarehouseError("invalid-descriptor", `Warehouse payload at ${path} exceeds nesting limit.`, {
      path,
    });
  }
  if (typeof value === "string") {
    if (containsSecretValue(value)) {
      throw new HonuaWarehouseError("secret-detected", `Warehouse payload at ${path} must not contain credentials.`, {
        path,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoWarehouseSecrets(value[index], `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new HonuaWarehouseError(
        "secret-detected",
        `Warehouse payload key "${key}" at ${path} is forbidden in browser descriptors and plans.`,
        { path: `${path}.${key}` },
      );
    }
    assertNoWarehouseSecrets(entry, `${path}.${key}`, depth + 1);
  }
}

/** Validates an opaque governed identifier (never raw SQL, whitespace, or secret material). */
export function assertOpaqueGovernedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HonuaWarehouseError("invalid-descriptor", `${label} must be a non-empty opaque identifier.`, { label });
  }
  if (/\s|;/.test(value) || RAW_SQL_STATEMENT_PATTERN.test(value)) {
    throw new HonuaWarehouseError(
      "invalid-descriptor",
      `${label} must be an opaque governed identifier and must not contain raw vendor SQL.`,
      { label },
    );
  }
  assertNoWarehouseSecrets(value, label);
  return value;
}

/** Rejects raw SQL snippets in fields that must stay declarative or opaque. */
export function assertNoRawVendorSql(value: string, label: string): void {
  if (RAW_SQL_STATEMENT_PATTERN.test(value)) {
    throw new HonuaWarehouseError("invalid-descriptor", `${label} must not expose raw vendor SQL to browser clients.`, {
      label,
    });
  }
}

export function containsSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableWarehouseJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableWarehouseJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableWarehouseJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
