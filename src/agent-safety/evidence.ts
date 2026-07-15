import { type ConnectDiscoverySnapshot, HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION } from "../connect.js";
import { CAPABILITIES, type Capability, PROTOCOLS } from "../contract/index.js";
import { type JsonValue, type QueryExecutionPlanV1, canonicalStringify, sha256 } from "../query-planner/index.js";
import { hashQueryPlanV1 } from "../query-planner/planner.js";
import {
  AGENT_SAFETY_EVIDENCE_KIND,
  AGENT_SAFETY_VERSION,
  type AgentDigest,
  type AgentSafetyEvidenceProvenanceV1,
  type AgentSafetyEvidenceV1,
  type AgentSafetyUnavailableFact,
  HonuaAgentSafetyError,
} from "./types.js";

const MAX_NODES = 8_192;
const MAX_DEPTH = 32;

export interface DeriveAgentSafetyEvidenceOptions {
  /** Presence only. Opaque cursor values must never cross this boundary. */
  readonly realtimeCursorPresent?: boolean;
  readonly freshness?: {
    readonly mode: "snapshot" | "watermark" | "cursor" | "delta" | "realtime";
    readonly maxAgeMs?: number;
  };
}

/** Derive immutable, credential-free safety facts from accepted SDK objects. */
export function deriveAgentSafetyEvidence(
  acceptedPlan: QueryExecutionPlanV1,
  acceptedDiscovery: ConnectDiscoverySnapshot,
  options: DeriveAgentSafetyEvidenceOptions = {},
): AgentSafetyEvidenceV1 {
  const plan = snapshotJson(acceptedPlan, "$plan") as unknown as QueryExecutionPlanV1;
  const discovery = snapshotJson(acceptedDiscovery, "$discovery") as unknown as ConnectDiscoverySnapshot;
  const capturedOptions = snapshotJson(options, "$options") as unknown as DeriveAgentSafetyEvidenceOptions;
  if (plan.kind !== "honua.query-plan" || plan.version !== "1.0") invalid("$plan is not a supported query plan");
  if (hashQueryPlanV1(plan) !== plan.fingerprint) integrity("$plan fingerprint does not match its accepted contents");
  if (discovery.version !== HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION) invalid("$discovery version is unsupported");
  if (!PROTOCOLS.includes(plan.ir.source.protocol)) invalid("$plan source protocol is unsupported");
  if (discovery.protocol !== plan.ir.source.protocol) integrity("discovery protocol differs from the accepted plan");
  const source = discovery.sources.find((candidate) => candidate.id === plan.ir.source.id);
  if (!source) integrity("discovery does not contain the accepted plan source");
  const capabilities = normalizedCapabilities(plan.ir.source.capabilities);
  const observedCapabilities = new Set(
    [...discovery.evidence, ...(source.evidence ?? [])].flatMap((entry) =>
      entry.kind === "unavailable" ? [] : [...entry.capabilities],
    ),
  );
  for (const capability of capabilities) {
    if (!observedCapabilities.has(capability)) integrity(`accepted capability ${capability} lacks discovery evidence`);
  }
  const observedAt = iso(discovery.retrievedAt, "$discovery.retrievedAt");
  const provenance = normalizeProvenance([...discovery.evidence, ...(source.evidence ?? [])]);
  const unavailableFacts: AgentSafetyUnavailableFact[] = [];
  if (plan.ir.source.schemaVersion === undefined) unavailableFacts.push("schema-version");
  if (plan.ir.source.sourceVersion === undefined) unavailableFacts.push("source-version");
  if (!capturedOptions.freshness) unavailableFacts.push("freshness-contract");
  if (provenance.length === 0) unavailableFacts.push("discovery-provenance");
  const freshness = capturedOptions.freshness;
  const unsigned = freezeDeep({
    kind: AGENT_SAFETY_EVIDENCE_KIND,
    version: AGENT_SAFETY_VERSION,
    source: {
      id: bounded(plan.ir.source.id, "$plan.ir.source.id"),
      protocol: plan.ir.source.protocol,
      endpointDigest: digest(redactEndpoint(plan.ir.source.endpoint)),
      schemaVersion: plan.ir.source.schemaVersion ?? null,
      sourceVersion: plan.ir.source.sourceVersion ?? null,
      authorizationScopeDigest: digest([...plan.ir.source.authorizationScope].sort()),
      capabilities,
    },
    plan: {
      id: bounded(plan.id, "$plan.id"),
      fingerprint: plan.fingerprint,
      operations: Object.freeze(plan.steps.map((step) => `${step.engine}:${step.operation}`)),
    },
    provenance,
    observedAt,
    freshness: {
      mode: freshness?.mode ?? "unavailable",
      maxAgeMs: freshness?.maxAgeMs ?? null,
      cursorPresent: capturedOptions.realtimeCursorPresent === true,
    },
    unavailableFacts: Object.freeze(unavailableFacts.sort()),
  });
  if (
    unsigned.freshness.maxAgeMs !== null &&
    (!Number.isSafeInteger(unsigned.freshness.maxAgeMs) || unsigned.freshness.maxAgeMs < 0)
  ) {
    invalid("$options.freshness.maxAgeMs must be a non-negative safe integer");
  }
  return freezeDeep({ ...unsigned, evidenceDigest: digest(unsigned) }) as AgentSafetyEvidenceV1;
}

/** Re-derive immediately before approval consumption and reject any drift. */
export function verifyAgentSafetyEvidence(
  receipt: AgentSafetyEvidenceV1,
  currentPlan: QueryExecutionPlanV1,
  currentDiscovery: ConnectDiscoverySnapshot,
  options: DeriveAgentSafetyEvidenceOptions = {},
): AgentSafetyEvidenceV1 {
  const expected = snapshotJson(receipt, "$evidence") as unknown as AgentSafetyEvidenceV1;
  const { evidenceDigest: _digest, ...unsigned } = expected;
  if (expected.kind !== AGENT_SAFETY_EVIDENCE_KIND || expected.version !== AGENT_SAFETY_VERSION)
    invalid("$evidence kind or version is unsupported");
  if (digest(unsigned) !== expected.evidenceDigest) integrity("safety evidence integrity check failed");
  const current = deriveAgentSafetyEvidence(currentPlan, currentDiscovery, options);
  if (current.evidenceDigest !== expected.evidenceDigest) integrity("current plan or discovery evidence drifted");
  return current;
}

function normalizeProvenance(
  evidence: ConnectDiscoverySnapshot["evidence"],
): readonly AgentSafetyEvidenceProvenanceV1[] {
  const values = new Map<string, AgentSafetyEvidenceProvenanceV1>();
  for (const record of evidence) {
    for (const provenance of record.provenance ?? []) {
      const source = bounded(provenance.source, "$discovery.evidence.provenance.source");
      const value = freezeDeep({
        sourceDigest: digest(redactEndpoint(source)),
        ...(provenance.retrievedAt ? { retrievedAt: iso(provenance.retrievedAt, "$provenance.retrievedAt") } : {}),
        ...(provenance.validator ? { validatorDigest: digest(provenance.validator) } : {}),
      });
      values.set(canonicalStringify(value as JsonValue), value);
    }
  }
  return Object.freeze([...values.values()].sort((a, b) => (a.sourceDigest < b.sourceDigest ? -1 : 1)));
}

function normalizedCapabilities(values: readonly Capability[]): readonly Capability[] {
  if (!Array.isArray(values) || values.length > CAPABILITIES.length) invalid("$plan source capabilities are invalid");
  const result = [...new Set(values)];
  if (result.some((value) => !CAPABILITIES.includes(value))) invalid("$plan contains an unknown capability");
  return Object.freeze(result.sort());
}

function redactEndpoint(value: string): string {
  const text = bounded(value, "$endpoint");
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return text;
  }
}

function bounded(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) invalid(`${path} must be bounded text`);
  return value;
}

function iso(value: unknown, path: string): string {
  const text = bounded(value, path);
  if (!Number.isFinite(Date.parse(text))) invalid(`${path} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

function digest(value: unknown): AgentDigest {
  return sha256(canonicalStringify(value as JsonValue));
}

function snapshotJson(value: unknown, path: string): JsonValue {
  return snapshot(value, path, new WeakSet<object>(), { nodes: 0 }, 0);
}

function snapshot(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) invalid(`${path} exceeds the evidence snapshot limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (!value || typeof value !== "object") invalid(`${path} is not JSON compatible`);
  if (ancestors.has(value)) invalid(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))
    invalid(`${path} must be plain data`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const length = data(value, "length", path);
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_NODES)
      invalid(`${path} array is invalid`);
    const arrayLength = length;
    const result: JsonValue[] = [];
    for (let index = 0; index < arrayLength; index += 1) {
      result.push(snapshot(data(value, String(index), path), `${path}[${index}]`, ancestors, budget, depth + 1));
    }
    ancestors.delete(value);
    return result;
  }
  const keys = Object.keys(value).sort();
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    const entry = data(value, key, path);
    if (entry !== undefined) result[key] = snapshot(entry, `${path}.${key}`, ancestors, budget, depth + 1);
  }
  ancestors.delete(value);
  return result;
}

function data(value: object, key: string, path: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (!descriptor) invalid(`${path}.${key} is missing`);
  if (descriptor.get || descriptor.set) invalid(`${path}.${key} must not be an accessor`);
  return descriptor.value;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function invalid(message: string): never {
  throw new HonuaAgentSafetyError("invalid-input", message);
}

function integrity(message: string): never {
  throw new HonuaAgentSafetyError("integrity-failed", message);
}
