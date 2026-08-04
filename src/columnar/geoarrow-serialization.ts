/**
 * Bounded, versioned persistence envelope for the normative GeoArrow mapping,
 * plus the migration ladder that keeps a persisted cache readable across an
 * envelope layout change (issue #940).
 *
 * Epic #394 requires that "persistent caches require versioned serialization
 * and migration". Serialization landed first and pinned a single envelope
 * version, so the moment the layout changed every persisted entry became
 * permanently unreadable. The ladder here closes that: a stored envelope is
 * migrated forward through an ordered registry of `fromVersion` → `toVersion`
 * steps before it is validated, and the applied chain is reported in the
 * deserialization metrics.
 *
 * Two properties are deliberate.
 *
 * 1. **Fail closed, before any payload is decoded.** Version resolution runs on
 *    the parsed envelope header. An unknown, future, or unreachable version
 *    throws `unsupported-serialization` with a stable message and no backing
 *    buffer is ever base64-decoded.
 * 2. **A migration cannot widen a caller's bounds.** A step receives only the
 *    parsed envelope — never the caller's {@link GeoArrowSerializationOptions} —
 *    and every ceiling is enforced against the migrated envelope, so migrating
 *    an old entry can never admit more bytes than a fresh read would.
 */
import type {
  GeoArrowBatchSerializationResult,
  GeoArrowEnvelopeMigrationPlanV1,
  GeoArrowEnvelopeMigrationV1,
  GeoArrowSerializationMetrics,
  GeoArrowSerializationOptions,
} from "./geoarrow-types.js";
import { HonuaGeoArrowError as GeoArrowError, HONUA_GEOARROW_LAYOUT_VERSION } from "./geoarrow-types.js";
import { inspectGeoArrowBatch } from "./geoarrow.js";
import type { ColumnarBatchV1, ColumnarBufferRole } from "./types.js";

/** Stable discriminator for a persisted GeoArrow batch envelope. */
export const HONUA_GEOARROW_ENVELOPE_KIND = "honua.geoarrow.batch" as const;

/**
 * Envelope layout version written today.
 *
 * `1.1` adds the decoded `byteLength` of every backing and stamps the GeoArrow
 * layout version, so backing ceilings are enforced before base64 is decoded
 * rather than after a caller-sized allocation already happened.
 */
export const HONUA_GEOARROW_ENVELOPE_VERSION = "1.1" as const;

const SERIALIZATION_KIND = HONUA_GEOARROW_ENVELOPE_KIND;
const SERIALIZATION_VERSION = HONUA_GEOARROW_ENVELOPE_VERSION;
const DEFAULT_MAX_SERIALIZED_BYTES = 128 * 1024 * 1024;
const BASE64_CHUNK = 0x8000;
/** Bound on ladder walks so a malformed or cyclic registry cannot spin. */
const MAX_MIGRATION_STEPS = 16;

interface SerializedBuffer {
  readonly id: string;
  readonly role: ColumnarBufferRole;
  readonly field?: string;
  readonly backingId: string;
  readonly byteOffset: number;
  readonly byteLength: number;
}

interface SerializedBacking {
  readonly id: string;
  /** Decoded length, declared since envelope 1.1 so bounds precede decoding. */
  readonly byteLength: number;
  data: string;
}

interface SerializedEnvelope {
  readonly kind: typeof SERIALIZATION_KIND;
  readonly version: typeof SERIALIZATION_VERSION;
  readonly layout: typeof HONUA_GEOARROW_LAYOUT_VERSION;
  readonly batch: Omit<ColumnarBatchV1, "buffers"> & { readonly buffers: readonly SerializedBuffer[] };
  readonly backings: readonly SerializedBacking[];
}

/**
 * Ordered migration ladder applied on read, oldest step first.
 *
 * Every step is a pure structural rewrite of one parsed envelope. `1.0 → 1.1`
 * derives each backing's decoded length from its base64 length — arithmetic on
 * the encoded string, never a decode — and stamps the layout version that
 * envelope 1.0 left implicit.
 */
export const GEOARROW_ENVELOPE_MIGRATIONS: readonly GeoArrowEnvelopeMigrationV1[] = Object.freeze([
  Object.freeze({
    fromVersion: "1.0",
    toVersion: "1.1",
    migrate: (envelope: Readonly<Record<string, unknown>>): Record<string, unknown> => {
      const backings = Array.isArray(envelope.backings) ? envelope.backings : [];
      return {
        ...envelope,
        version: "1.1",
        layout: HONUA_GEOARROW_LAYOUT_VERSION,
        backings: backings.map((backing) => {
          if (!isRecord(backing)) return backing;
          return { ...backing, byteLength: base64DecodedLength(backing.data) };
        }),
      };
    },
  }),
]) as readonly GeoArrowEnvelopeMigrationV1[];

function fail(
  message: string,
  code: "invalid-batch" | "serialization-limit-exceeded" | "unsupported-serialization",
): never {
  throw new GeoArrowError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + BASE64_CHUNK, bytes.length)));
  }
  return btoa(binary);
}

function fromBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail(`${label} must be valid base64.`, "invalid-batch");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw new GeoArrowError("invalid-batch", `${label} must be valid base64.`, undefined, { cause });
  }
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function serializedLimit(options: GeoArrowSerializationOptions): number {
  const limit = options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    fail("maxSerializedBytes must be a positive safe integer.", "invalid-batch");
  return limit;
}

function encodeEnvelope(envelope: SerializedEnvelope, limit: number): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.byteLength > limit) {
    fail(`GeoArrow envelope is ${bytes.byteLength} bytes; the limit is ${limit}.`, "serialization-limit-exceeded");
  }
  return bytes;
}

/**
 * Resolve the ordered steps that carry `version` forward to `targetVersion`.
 *
 * Exported because a host that persists envelopes needs to answer "can this
 * entry still be read?" without decoding it, and because the unreachable case —
 * a ladder whose chain dead-ends before the target — has to be provable rather
 * than assumed. The walk is bounded and cycle-safe: at most
 * {@link MAX_MIGRATION_STEPS} steps, and no version is visited twice.
 */
export function planGeoArrowEnvelopeMigration(
  version: unknown,
  migrations: readonly GeoArrowEnvelopeMigrationV1[] = GEOARROW_ENVELOPE_MIGRATIONS,
  targetVersion: string = SERIALIZATION_VERSION,
): GeoArrowEnvelopeMigrationPlanV1 {
  if (typeof version !== "string" || !isLayoutVersion(version)) {
    return { applicable: false, reason: "unknown-version", detail: `"${String(version)}" is not a layout version.` };
  }
  if (version === targetVersion) return { applicable: true, steps: Object.freeze([]), migrations: Object.freeze([]) };
  const steps: string[] = [];
  const applied: GeoArrowEnvelopeMigrationV1[] = [];
  const visited = new Set<string>([version]);
  let cursor = version;
  while (steps.length < MAX_MIGRATION_STEPS) {
    const step = migrations.find((candidate) => candidate.fromVersion === cursor);
    if (!step) break;
    if (visited.has(step.toVersion)) break;
    visited.add(step.toVersion);
    steps.push(`${step.fromVersion}->${step.toVersion}`);
    applied.push(step);
    cursor = step.toVersion;
    if (cursor === targetVersion) {
      return { applicable: true, steps: Object.freeze(steps), migrations: Object.freeze(applied) };
    }
  }
  // The walk stalled. A version the ladder has never heard of is unknown (or
  // ahead of this build); one the ladder knows but cannot carry home is an
  // unreachable path, and both refuse rather than guess at a layout.
  const known = migrations.some((step) => step.fromVersion === version || step.toVersion === version);
  if (steps.length > 0 || known) {
    return {
      applicable: false,
      reason: "unreachable-version",
      detail: `No migration path carries envelope version "${version}" to "${targetVersion}".`,
    };
  }
  return {
    applicable: false,
    reason: compareLayoutVersions(version, targetVersion) > 0 ? "future-version" : "unknown-version",
    detail: `Envelope version "${version}" has no migration to "${targetVersion}".`,
  };
}

function readEnvelope(
  input: Uint8Array | ArrayBuffer,
  limit: number,
  migrations: readonly GeoArrowEnvelopeMigrationV1[],
): { envelope: SerializedEnvelope; byteLength: number; applied: readonly string[] } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > limit) {
    fail(`GeoArrow envelope is ${bytes.byteLength} bytes; the limit is ${limit}.`, "serialization-limit-exceeded");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new GeoArrowError("invalid-batch", "GeoArrow envelope must be valid UTF-8 JSON.", undefined, { cause });
  }
  if (!isRecord(value) || value.kind !== SERIALIZATION_KIND) {
    fail(
      `Unsupported GeoArrow serialization kind "${String(isRecord(value) ? value.kind : undefined)}".`,
      "unsupported-serialization",
    );
  }
  // Version resolution precedes every payload read: an envelope this build
  // cannot carry forward is refused before a single backing is decoded.
  const storedVersion = typeof value.version === "string" ? value.version : String(value.version);
  const plan = planGeoArrowEnvelopeMigration(value.version, migrations);
  if (!plan.applicable) {
    fail(`Unsupported GeoArrow serialization version "${storedVersion}". ${plan.detail}`, "unsupported-serialization");
  }
  let migrated: Record<string, unknown> = value;
  for (const step of plan.migrations) {
    // A step sees only the envelope, never the caller's options, so no
    // migration can widen a bound the caller set.
    const next = step.migrate(Object.freeze({ ...migrated }));
    if (!isRecord(next) || next.version !== step.toVersion) {
      fail(
        `GeoArrow migration ${step.fromVersion}->${step.toVersion} did not produce a "${step.toVersion}" envelope.`,
        "unsupported-serialization",
      );
    }
    migrated = next;
  }
  if (migrated.version !== SERIALIZATION_VERSION) {
    // Defensive: the plan only resolves when its chain ends at the target and
    // each step's output was verified above, so reaching here means a step
    // rewrote the version underneath the ladder.
    fail(
      `Unsupported GeoArrow serialization version "${storedVersion}"; migration did not reach "${SERIALIZATION_VERSION}".`,
      "unsupported-serialization",
    );
  }
  if (migrated.layout !== HONUA_GEOARROW_LAYOUT_VERSION) {
    // Envelope 1.0 carried no layout stamp, so its migration supplies this
    // build's; a stamp that still disagrees came from a foreign layout and the
    // buffers underneath it cannot be interpreted here.
    fail(
      `Unsupported GeoArrow layout version "${String(migrated.layout)}"; this build reads "${HONUA_GEOARROW_LAYOUT_VERSION}".`,
      "unsupported-serialization",
    );
  }
  if (!isRecord(migrated.batch) || !Array.isArray(migrated.batch.buffers) || !Array.isArray(migrated.backings)) {
    fail("GeoArrow envelope is missing its batch or backing buffers.", "invalid-batch");
  }
  return {
    envelope: migrated as unknown as SerializedEnvelope,
    byteLength: bytes.byteLength,
    applied: plan.steps,
  };
}

function metrics(
  serializedBytes: number,
  batch: ColumnarBatchV1,
  envelopeVersion: string,
  migrations: readonly string[],
): GeoArrowSerializationMetrics {
  const seen = new Set<ArrayBuffer>();
  for (const buffer of batch.buffers) seen.add(buffer.data);
  return Object.freeze({
    serializedBytes,
    backingBytes: [...seen].reduce((total, data) => total + data.byteLength, 0),
    backingBuffers: seen.size,
    envelopeVersion,
    migrations: Object.freeze([...migrations]),
  });
}

/** Layout versions are `<major>.<minor>` digit pairs; no regex, no backtracking. */
function isLayoutVersion(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  return parts.every(
    (part) => part.length > 0 && part.length <= 6 && [...part].every((char) => char >= "0" && char <= "9"),
  );
}

function compareLayoutVersions(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0] = left.split(".").map(Number);
  const [rightMajor = 0, rightMinor = 0] = right.split(".").map(Number);
  if (leftMajor !== rightMajor) return leftMajor < rightMajor ? -1 : 1;
  if (leftMinor !== rightMinor) return leftMinor < rightMinor ? -1 : 1;
  return 0;
}

/** Decoded length of a base64 string, computed from its length and padding. */
function base64DecodedLength(value: unknown): number {
  if (typeof value !== "string" || value.length % 4 !== 0) return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Serialize one validated GeoArrow batch into a bounded, versioned persistence envelope. */
export function serializeGeoArrowBatch(batch: ColumnarBatchV1, options: GeoArrowSerializationOptions = {}): Uint8Array {
  const limit = serializedLimit(options);
  const inspection = inspectGeoArrowBatch(batch, options);
  const backings: SerializedBacking[] = [];
  const backingViews: Uint8Array[] = [];
  const backingIds = new Map<ArrayBuffer, string>();
  const buffers: SerializedBuffer[] = [];
  for (const descriptor of inspection.batch.buffers) {
    let backingId = backingIds.get(descriptor.data);
    if (!backingId) {
      backingId = `backing-${backings.length}`;
      backingIds.set(descriptor.data, backingId);
      backings.push({ id: backingId, byteLength: descriptor.data.byteLength, data: "" });
      backingViews.push(new Uint8Array(descriptor.data));
    }
    buffers.push({
      id: descriptor.id,
      role: descriptor.role,
      ...(descriptor.field === undefined ? {} : { field: descriptor.field }),
      backingId,
      byteOffset: descriptor.byteOffset,
      byteLength: descriptor.byteLength,
    });
  }
  const envelope: SerializedEnvelope = {
    kind: SERIALIZATION_KIND,
    version: SERIALIZATION_VERSION,
    layout: HONUA_GEOARROW_LAYOUT_VERSION,
    batch: { ...inspection.batch, buffers },
    backings,
  };
  const base64Bytes = backingViews.reduce((total, bytes) => total + 4 * Math.ceil(bytes.byteLength / 3), 0);
  const envelopeOverhead = new TextEncoder().encode(
    JSON.stringify({ ...envelope, backings: backings.map(({ id, byteLength }) => ({ id, byteLength, data: "" })) }),
  ).byteLength;
  if (envelopeOverhead + base64Bytes > limit) {
    fail(
      `GeoArrow envelope requires at least ${envelopeOverhead + base64Bytes} bytes; the limit is ${limit}.`,
      "serialization-limit-exceeded",
    );
  }
  backings.forEach((backing, index) => {
    backing.data = toBase64(backingViews[index]!);
  });
  return encodeEnvelope(envelope, limit);
}

/**
 * Report which envelope versions this build can still read.
 *
 * A store uses it to decide whether a persisted entry is worth keeping without
 * decoding it, and a diagnostic uses it to explain why an entry was discarded.
 */
export function readableGeoArrowEnvelopeVersions(
  migrations: readonly GeoArrowEnvelopeMigrationV1[] = GEOARROW_ENVELOPE_MIGRATIONS,
): readonly string[] {
  const versions = new Set<string>([SERIALIZATION_VERSION]);
  for (const step of migrations) {
    if (planGeoArrowEnvelopeMigration(step.fromVersion, migrations).applicable) versions.add(step.fromVersion);
  }
  return Object.freeze([...versions].sort());
}

/** Deserialize and revalidate a persisted GeoArrow envelope with explicit size ceilings. */
export function deserializeGeoArrowBatch(
  input: Uint8Array | ArrayBuffer,
  options: GeoArrowSerializationOptions = {},
): GeoArrowBatchSerializationResult {
  const limit = serializedLimit(options);
  const { envelope, byteLength, applied } = readEnvelope(
    input,
    limit,
    options.migrations ?? GEOARROW_ENVELOPE_MIGRATIONS,
  );
  const backingMap = new Map<string, ArrayBuffer>();
  let backingBytes = 0;
  for (const backing of envelope.backings) {
    if (!isRecord(backing) || typeof backing.id !== "string" || backingMap.has(backing.id)) {
      fail("GeoArrow envelope contains an invalid or duplicate backing id.", "invalid-batch");
    }
    // Declared since envelope 1.1 and derived by the 1.0 migration, so the
    // ceiling is enforced against the migrated envelope before any allocation.
    const declared = backing.byteLength;
    if (!Number.isSafeInteger(declared) || (declared as number) < 0) {
      fail(`GeoArrow backing ${backing.id} does not declare a decoded byte length.`, "invalid-batch");
    }
    if (options.maxBackingBytes !== undefined && backingBytes + (declared as number) > options.maxBackingBytes) {
      fail(`GeoArrow backings exceed the ${options.maxBackingBytes}-byte limit.`, "serialization-limit-exceeded");
    }
    const bytes = fromBase64(backing.data, `backing ${backing.id}`);
    if (bytes.byteLength !== declared) {
      fail(`GeoArrow backing ${backing.id} decoded to ${bytes.byteLength} bytes, not ${declared}.`, "invalid-batch");
    }
    backingBytes += bytes.byteLength;
    backingMap.set(backing.id, bytes.buffer as ArrayBuffer);
  }
  const serializedBatch = envelope.batch;
  const buffers = serializedBatch.buffers.map((descriptor) => {
    if (!isRecord(descriptor) || typeof descriptor.id !== "string" || typeof descriptor.backingId !== "string") {
      fail("GeoArrow envelope contains an invalid buffer descriptor.", "invalid-batch");
    }
    const data = backingMap.get(descriptor.backingId);
    if (!data) fail(`GeoArrow buffer references unknown backing "${descriptor.backingId}".`, "invalid-batch");
    return {
      id: descriptor.id,
      role: descriptor.role,
      ...(descriptor.field === undefined ? {} : { field: descriptor.field }),
      data,
      byteOffset: descriptor.byteOffset,
      byteLength: descriptor.byteLength,
    };
  });
  const batch = { ...serializedBatch, buffers } as ColumnarBatchV1;
  inspectGeoArrowBatch(batch, options);
  return Object.freeze({
    batch,
    metrics: metrics(byteLength, batch, SERIALIZATION_VERSION, applied),
  });
}

export type { GeoArrowBatchSerializationResult, GeoArrowSerializationMetrics } from "./geoarrow-types.js";
