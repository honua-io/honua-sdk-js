import {
  DECK_GL_ADAPTER_CONTRACT_VERSION,
  type DeckGlAdapter,
  type DeckGlBinaryAttribute,
  type DeckGlCapability,
  type DeckGlLayer,
  type DeckGlLayerHost,
  type DeckGlMountedProjection,
  type DeckGlPeers,
  type DeckGlPickedSelection,
  type DeckGlProjection,
  type DeckGlProjectionLimits,
  type DeckGlProjectionMetrics,
  type DeckGlProjectionRequest,
  HonuaDeckGlAdapterError,
  type LoadDeckGlPeersOptions,
} from "./types.js";

const MAX_DESCRIPTOR_KEY_LENGTH = 256;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayLength = requiredGetter(TYPED_ARRAY_PROTOTYPE, "length");
const typedArrayByteLength = requiredGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const typedArrayByteOffset = requiredGetter(TYPED_ARRAY_PROTOTYPE, "byteOffset");
const typedArrayBuffer = requiredGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const typedArrayTag = requiredGetter(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag);
const arrayBufferByteLength = requiredGetter(ArrayBuffer.prototype, "byteLength");
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === "undefined" ? undefined : requiredGetter(SharedArrayBuffer.prototype, "byteLength");

export const DEFAULT_DECK_GL_PROJECTION_LIMITS: DeckGlProjectionLimits = Object.freeze({
  maxRows: 1_000_000,
  maxAttributes: 32,
  maxProps: 64,
  maxBackingBytes: 256 * 1024 * 1024,
});

export const DECK_GL_CAPABILITIES: readonly DeckGlCapability[] = Object.freeze([
  Object.freeze({
    layer: "scatterplot",
    supported: true,
    execution: "gpu-binary",
    reason: "Zero-copy deck.gl binary attributes are supported.",
  }),
  ...(
    [
      "feature-path",
      "feature-polygon",
      "vector-tile",
      "h3",
      "quadbin",
      "heatmap",
      "cluster",
      "contour",
      "trips",
    ] as const
  ).map(
    (layer): DeckGlCapability =>
      Object.freeze({
        layer,
        supported: false,
        execution: "not-implemented",
        reason: `${layer} projection is outside adapter contract v1.0.`,
      }),
  ),
]);

const defaultImportModule = (specifier: string): Promise<unknown> => import(specifier);

export async function loadDeckGlPeers(options: LoadDeckGlPeersOptions = {}): Promise<DeckGlPeers> {
  let module: unknown;
  try {
    module = await (options.importModule ?? defaultImportModule)("@deck.gl/layers");
  } catch (cause) {
    throw new HonuaDeckGlAdapterError(
      "missing-peer",
      'The deck.gl adapter requires the optional peer "@deck.gl/layers". Install it or inject DeckGlPeers.',
      { package: "@deck.gl/layers" },
      { cause },
    );
  }
  const ScatterplotLayer = isRecord(module)
    ? readOnce(module, "ScatterplotLayer", "@deck.gl/layers.ScatterplotLayer")
    : undefined;
  if (typeof ScatterplotLayer !== "function") {
    throw new HonuaDeckGlAdapterError(
      "missing-peer",
      'The loaded "@deck.gl/layers" module does not export ScatterplotLayer.',
      { package: "@deck.gl/layers", export: "ScatterplotLayer" },
    );
  }
  return Object.freeze({ ScatterplotLayer: ScatterplotLayer as DeckGlPeers["ScatterplotLayer"] });
}

export interface CreateDeckGlAdapterOptions {
  readonly peers: DeckGlPeers;
  readonly limits?: Partial<DeckGlProjectionLimits>;
}

export function createDeckGlAdapter(options: CreateDeckGlAdapterOptions): DeckGlAdapter {
  const peers = validatePeers(options.peers);
  const limits = normalizeLimits(options.limits);
  const mounted = new Set<DeckGlMountedProjection>();
  let disposeRequested = false;

  return {
    capabilities: DECK_GL_CAPABILITIES,
    limits,
    get disposed() {
      return disposeRequested;
    },
    project(request) {
      if (disposeRequested) throw disposedError("project");
      const snapshot = normalizeProjectionRequest(request, limits);
      return createProjection(peers, limits, snapshot, mounted, () => disposeRequested);
    },
    dispose() {
      disposeRequested = true;
      const errors: HonuaDeckGlAdapterError[] = [];
      for (const handle of [...mounted]) {
        try {
          handle.dispose();
        } catch (error) {
          errors.push(asDisposalError(error));
        }
      }
      if (errors.length > 0) {
        throw new HonuaDeckGlAdapterError(
          "dispose-failed",
          `${errors.length} deck.gl layer host removal${errors.length === 1 ? "" : "s"} failed and can be retried.`,
          { failures: errors.length, remainingMounts: mounted.size },
          { cause: new AggregateError(errors) },
        );
      }
    },
  };
}

interface ProjectionSnapshot {
  readonly layer: unknown;
  readonly layerId: unknown;
  readonly rowCount: unknown;
  readonly attributes: Readonly<Record<string, AttributeSnapshot>>;
  readonly sourceId: unknown;
  readonly planId: unknown;
  readonly sourceVersion: unknown;
  readonly featureIds: readonly unknown[];
  readonly props: Readonly<Record<string, unknown>>;
}

interface AttributeSnapshot {
  readonly value: unknown;
  readonly size: unknown;
  readonly offset: unknown;
  readonly stride: unknown;
  readonly normalized: unknown;
}

type ValidatedAttribute = DeckGlBinaryAttribute;

interface ValidatedProjection {
  readonly layerId: string;
  readonly rowCount: number;
  readonly attributes: Readonly<Record<string, ValidatedAttribute>>;
  readonly sourceId: string;
  readonly planId: string;
  readonly sourceVersion: string | undefined;
  readonly featureIds: readonly (string | number | bigint)[];
  readonly props: Readonly<Record<string, unknown>>;
  readonly metrics: DeckGlProjectionMetrics;
}

function normalizeProjectionRequest(
  foreignRequest: DeckGlProjectionRequest,
  limits: DeckGlProjectionLimits,
): ProjectionSnapshot {
  const request = requireRecord(foreignRequest, "request");
  const layer = readOnce(request, "layer", "request.layer");
  const layerId = readOnce(request, "layerId", "request.layerId");
  const data = requireRecord(readOnce(request, "data", "request.data"), "request.data");
  const identity = requireRecord(readOnce(request, "identity", "request.identity"), "request.identity");
  const foreignProps = readOnce(request, "props", "request.props");

  const foreignRowCount = readOnce(data, "length", "request.data.length");
  if (!Number.isSafeInteger(foreignRowCount) || (foreignRowCount as number) < 0) {
    throw new HonuaDeckGlAdapterError("invalid-data", "data.length must be a non-negative safe integer.");
  }
  const rowCount = foreignRowCount as number;
  if (rowCount > limits.maxRows) throw limitError("rows", rowCount, limits.maxRows);
  const foreignAttributes = requireRecord(
    readOnce(data, "attributes", "request.data.attributes"),
    "request.data.attributes",
  );
  const attributeKeys = ownEnumerableKeys(foreignAttributes, limits.maxAttributes, "attributes");
  const attributes: Record<string, AttributeSnapshot> = Object.create(null) as Record<string, AttributeSnapshot>;
  for (const name of attributeKeys) {
    validateDescriptorKey(name, "attribute");
    const foreignAttribute = requireRecord(
      readOnce(foreignAttributes, name, `request.data.attributes.${name}`),
      `request.data.attributes.${name}`,
    );
    attributes[name] = Object.freeze({
      value: readOnce(foreignAttribute, "value", `request.data.attributes.${name}.value`),
      size: readOnce(foreignAttribute, "size", `request.data.attributes.${name}.size`),
      offset: readOnce(foreignAttribute, "offset", `request.data.attributes.${name}.offset`),
      stride: readOnce(foreignAttribute, "stride", `request.data.attributes.${name}.stride`),
      normalized: readOnce(foreignAttribute, "normalized", `request.data.attributes.${name}.normalized`),
    });
  }

  const sourceId = readOnce(identity, "sourceId", "request.identity.sourceId");
  const planId = readOnce(identity, "planId", "request.identity.planId");
  const sourceVersion = readOnce(identity, "sourceVersion", "request.identity.sourceVersion");
  const foreignFeatureIds = requireRecord(
    readOnce(identity, "featureIds", "request.identity.featureIds"),
    "request.identity.featureIds",
  );
  const featureIdLength = readOnce(foreignFeatureIds, "length", "request.identity.featureIds.length");
  if (featureIdLength !== rowCount) {
    throw new HonuaDeckGlAdapterError("invalid-data", "identity.featureIds length must equal data.length.", {
      rows: rowCount,
      featureIds: featureIdLength,
    });
  }
  const featureIds: unknown[] = new Array(rowCount);
  for (let index = 0; index < rowCount; index += 1) {
    featureIds[index] = readOnce(foreignFeatureIds, String(index), `request.identity.featureIds[${index}]`);
  }

  const props = normalizeProps(foreignProps, limits.maxProps);
  return Object.freeze({
    layer,
    layerId,
    rowCount,
    attributes: Object.freeze(attributes),
    sourceId,
    planId,
    sourceVersion,
    featureIds: Object.freeze(featureIds),
    props,
  });
}

function createProjection(
  peers: DeckGlPeers,
  limits: DeckGlProjectionLimits,
  snapshot: ProjectionSnapshot,
  ownedMounts: Set<DeckGlMountedProjection>,
  adapterDisposed: () => boolean,
): DeckGlProjection {
  const validated = validateProjectionSnapshot(snapshot, limits);
  const binaryData = Object.freeze({
    length: validated.rowCount,
    attributes: validated.attributes,
  });
  const layer = new peers.ScatterplotLayer({
    ...validated.props,
    id: validated.layerId,
    data: binaryData,
    pickable: true,
  });

  return Object.freeze({
    contractVersion: DECK_GL_ADAPTER_CONTRACT_VERSION,
    layer,
    metrics: validated.metrics,
    diagnostic: Object.freeze({
      strategy: "gpu-binary" as const,
      fidelity: "exact-input" as const,
      precision: "input-array" as const,
      fallback: "none" as const,
      message: "Typed-array views are forwarded to deck.gl without SDK payload copies.",
    }),
    selectionForPick(index: number): DeckGlPickedSelection {
      if (!Number.isSafeInteger(index) || index < 0 || index >= validated.rowCount) {
        throw new HonuaDeckGlAdapterError(
          "invalid-data",
          `Pick index ${index} is outside [0, ${validated.rowCount}).`,
          { index, rows: validated.rowCount },
        );
      }
      return Object.freeze({
        sourceId: validated.sourceId,
        planId: validated.planId,
        ...(validated.sourceVersion === undefined ? {} : { sourceVersion: validated.sourceVersion }),
        featureId: validated.featureIds[index],
        rowIndex: index,
      });
    },
    mount(host: DeckGlLayerHost): DeckGlMountedProjection {
      if (adapterDisposed()) throw disposedError("mount a projection");
      const normalizedHost = normalizeHost(host);
      let adding = true;
      let removing = false;
      let removalRequested = false;
      let mountDisposed = false;
      const mountedHandle: DeckGlMountedProjection = {
        layer,
        get disposed() {
          return mountDisposed;
        },
        dispose() {
          if (mountDisposed) return;
          removalRequested = true;
          if (adding || removing) return;
          removing = true;
          try {
            normalizedHost.removeLayer(layer);
          } catch (cause) {
            removing = false;
            throw new HonuaDeckGlAdapterError(
              "dispose-failed",
              `deck.gl host failed to remove layer "${validated.layerId}"; disposal can be retried.`,
              { layerId: validated.layerId },
              { cause },
            );
          }
          removing = false;
          mountDisposed = true;
          ownedMounts.delete(mountedHandle);
        },
      };
      ownedMounts.add(mountedHandle);
      try {
        normalizedHost.addLayer(layer);
      } catch (addCause) {
        adding = false;
        try {
          mountedHandle.dispose();
        } catch (removeCause) {
          throw new HonuaDeckGlAdapterError(
            "dispose-failed",
            `deck.gl host failed to add and roll back layer "${validated.layerId}"; removal can be retried.`,
            { layerId: validated.layerId, remainingMounts: ownedMounts.size },
            { cause: new AggregateError([addCause, removeCause]) },
          );
        }
        throw addCause;
      }
      adding = false;
      if (adapterDisposed() || removalRequested) {
        mountedHandle.dispose();
        throw disposedError("complete a mount started before dispose()");
      }
      return mountedHandle;
    },
  });
}

function validateProjectionSnapshot(snapshot: ProjectionSnapshot, limits: DeckGlProjectionLimits): ValidatedProjection {
  if (snapshot.layer !== "scatterplot") {
    throw new HonuaDeckGlAdapterError(
      "unsupported-layer",
      `Layer "${String(snapshot.layer)}" is not supported by contract v1.0.`,
      { layer: snapshot.layer, supported: ["scatterplot"] },
    );
  }
  const layerId = requireNonEmptyString(snapshot.layerId, "layerId");
  const sourceId = requireNonEmptyString(snapshot.sourceId, "identity.sourceId");
  const planId = requireNonEmptyString(snapshot.planId, "identity.planId");
  if (snapshot.sourceVersion !== undefined && typeof snapshot.sourceVersion !== "string") {
    throw new HonuaDeckGlAdapterError("invalid-data", "identity.sourceVersion must be a string when provided.");
  }
  const rowCount = snapshot.rowCount as number;
  const attributeEntries = Object.entries(snapshot.attributes);
  if (attributeEntries.length === 0) {
    throw new HonuaDeckGlAdapterError("invalid-data", "At least one binary attribute is required.");
  }
  if (!("getPosition" in snapshot.attributes)) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      'Scatterplot projection requires a "getPosition" binary attribute.',
    );
  }

  const attributes: Record<string, ValidatedAttribute> = Object.create(null) as Record<string, ValidatedAttribute>;
  const backings = new Set<ArrayBufferLike>();
  let logicalViewBytes = 0;
  let uniqueBackingBytes = 0;
  for (const [name, attribute] of attributeEntries) {
    const facts = typedArrayFacts(attribute.value, name);
    if (!Number.isInteger(attribute.size) || (attribute.size as number) < 1 || (attribute.size as number) > 4) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" size must be an integer from 1 through 4.`,
      );
    }
    if (attribute.normalized !== undefined && typeof attribute.normalized !== "boolean") {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" normalized must be boolean when provided.`,
      );
    }
    const size = attribute.size as 1 | 2 | 3 | 4;
    const offset = attribute.offset === undefined ? 0 : attribute.offset;
    const stride = attribute.stride === undefined ? size * facts.elementBytes : attribute.stride;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
      throw new HonuaDeckGlAdapterError("invalid-data", `Attribute "${name}" offset must be a non-negative integer.`);
    }
    if (!Number.isSafeInteger(stride) || (stride as number) <= 0) {
      throw new HonuaDeckGlAdapterError("invalid-data", `Attribute "${name}" stride must be a positive integer.`);
    }
    if ((offset as number) % facts.elementBytes !== 0 || (stride as number) % facts.elementBytes !== 0) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" offset and stride must align to its ${facts.elementBytes}-byte components.`,
      );
    }
    if ((stride as number) < size * facts.elementBytes) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" stride must cover all ${size} components.`,
      );
    }
    if (facts.byteOffset % facts.elementBytes !== 0) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" typed-array byteOffset is not component-aligned.`,
      );
    }
    const addressedBytes =
      rowCount === 0 ? 0 : (offset as number) + (rowCount - 1) * (stride as number) + size * facts.elementBytes;
    if (
      (offset as number) > facts.byteLength ||
      !Number.isSafeInteger(addressedBytes) ||
      addressedBytes > facts.byteLength
    ) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" cannot address ${rowCount} rows within its view.`,
      );
    }
    logicalViewBytes += facts.byteLength;
    if (!backings.has(facts.buffer)) {
      backings.add(facts.buffer);
      uniqueBackingBytes += facts.backingByteLength;
      if (uniqueBackingBytes > limits.maxBackingBytes) {
        throw limitError("unique backing bytes", uniqueBackingBytes, limits.maxBackingBytes);
      }
    }
    attributes[name] = Object.freeze({
      value: attribute.value as Exclude<ArrayBufferView, DataView>,
      size,
      ...(attribute.offset === undefined ? {} : { offset: offset as number }),
      ...(attribute.stride === undefined ? {} : { stride: stride as number }),
      ...(attribute.normalized === undefined ? {} : { normalized: attribute.normalized as boolean }),
    });
  }

  snapshot.featureIds.forEach((featureId, index) => {
    if (!isSelectionScalar(featureId) || (typeof featureId === "number" && !Number.isFinite(featureId))) {
      throw new HonuaDeckGlAdapterError("invalid-data", `identity.featureIds[${index}] is not a stable scalar.`, {
        index,
      });
    }
  });
  return Object.freeze({
    layerId,
    rowCount,
    attributes: Object.freeze(attributes),
    sourceId,
    planId,
    sourceVersion: snapshot.sourceVersion as string | undefined,
    featureIds: snapshot.featureIds as readonly (string | number | bigint)[],
    props: snapshot.props,
    metrics: Object.freeze({
      rows: rowCount,
      attributes: attributeEntries.length,
      logicalViewBytes,
      uniqueBackingBytes,
      copiedBytes: 0,
    }),
  });
}

function normalizeProps(foreignProps: unknown, maxProps: number): Readonly<Record<string, unknown>> {
  if (foreignProps === undefined) return Object.freeze({});
  const propsRecord = requireRecord(foreignProps, "request.props");
  const keys = ownEnumerableKeys(propsRecord, maxProps, "props");
  const props: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    validateDescriptorKey(key, "prop");
    if (key === "id" || key === "data" || key === "pickable") {
      throw new HonuaDeckGlAdapterError("invalid-data", `props.${key} is reserved by the Honua adapter.`, {
        property: key,
      });
    }
    props[key] = readOnce(propsRecord, key, `request.props.${key}`);
  }
  return Object.freeze(props);
}

function normalizeHost(foreignHost: DeckGlLayerHost): {
  readonly addLayer: (layer: DeckGlLayer) => void;
  readonly removeLayer: (layer: DeckGlLayer) => void;
} {
  const host = requireRecord(foreignHost, "host");
  const addLayer = readOnce(host, "addLayer", "host.addLayer");
  const removeLayer = readOnce(host, "removeLayer", "host.removeLayer");
  if (typeof addLayer !== "function" || typeof removeLayer !== "function") {
    throw new HonuaDeckGlAdapterError("invalid-data", "A deck.gl layer host must implement addLayer and removeLayer.");
  }
  return Object.freeze({
    addLayer: (layer: DeckGlLayer) => Reflect.apply(addLayer, host, [layer]),
    removeLayer: (layer: DeckGlLayer) => Reflect.apply(removeLayer, host, [layer]),
  });
}

function ownEnumerableKeys(record: Record<PropertyKey, unknown>, limit: number, label: string): readonly string[] {
  const keys: string[] = [];
  try {
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (keys.length === limit) throw limitError(label, limit + 1, limit);
      keys.push(key);
    }
  } catch (cause) {
    if (cause instanceof HonuaDeckGlAdapterError) throw cause;
    throw new HonuaDeckGlAdapterError("invalid-data", `Unable to enumerate ${label}.`, { label }, { cause });
  }
  return Object.freeze(keys);
}

function readOnce(record: Record<PropertyKey, unknown>, key: PropertyKey, path: string): unknown {
  try {
    return Reflect.get(record, key);
  } catch (cause) {
    throw new HonuaDeckGlAdapterError("invalid-data", `Unable to read ${path}.`, { path }, { cause });
  }
}

function requireRecord(value: unknown, path: string): Record<PropertyKey, unknown> {
  if (!isRecord(value)) {
    throw new HonuaDeckGlAdapterError("invalid-data", `${path} must be an object.`, { path });
  }
  return value;
}

function validateDescriptorKey(key: string, kind: "attribute" | "prop"): void {
  if (key.length === 0 || key.length > MAX_DESCRIPTOR_KEY_LENGTH) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `${kind} key length must be between 1 and ${MAX_DESCRIPTOR_KEY_LENGTH} characters.`,
      { kind, length: key.length, limit: MAX_DESCRIPTOR_KEY_LENGTH },
    );
  }
}

function typedArrayFacts(
  value: unknown,
  name: string,
): {
  readonly elementBytes: number;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly buffer: ArrayBufferLike;
  readonly backingByteLength: number;
} {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) {
    throw new HonuaDeckGlAdapterError("invalid-data", `Attribute "${name}" must use a typed-array view.`);
  }
  try {
    const tag = Reflect.apply(typedArrayTag, value, []) as string;
    const elementBytes = componentBytes(tag);
    const length = Reflect.apply(typedArrayLength, value, []) as number;
    const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    const byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
    const buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
    if (length * elementBytes !== byteLength) {
      throw new Error("typed-array intrinsic length mismatch");
    }
    return Object.freeze({
      elementBytes,
      byteLength,
      byteOffset,
      buffer,
      backingByteLength: intrinsicBackingByteLength(buffer),
    });
  } catch (cause) {
    if (cause instanceof HonuaDeckGlAdapterError) throw cause;
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `Attribute "${name}" typed-array metadata is invalid.`,
      { attribute: name },
      { cause },
    );
  }
}

function componentBytes(tag: string): number {
  switch (tag) {
    case "Int8Array":
    case "Uint8Array":
    case "Uint8ClampedArray":
      return 1;
    case "Int16Array":
    case "Uint16Array":
    case "Float16Array":
      return 2;
    case "Int32Array":
    case "Uint32Array":
    case "Float32Array":
      return 4;
    case "Float64Array":
      return 8;
    default:
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Typed-array component type "${tag}" is not supported by the deck.gl v1.0 adapter.`,
        { componentType: tag },
      );
  }
}

function intrinsicBackingByteLength(buffer: ArrayBufferLike): number {
  try {
    return Reflect.apply(arrayBufferByteLength, buffer, []) as number;
  } catch (arrayBufferCause) {
    if (sharedArrayBufferByteLength) {
      try {
        return Reflect.apply(sharedArrayBufferByteLength, buffer, []) as number;
      } catch {
        // Use the typed ArrayBuffer failure as the primary cause below.
      }
    }
    throw arrayBufferCause;
  }
}

function requiredGetter(target: object, key: PropertyKey): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(target, key)?.get;
  if (!getter) throw new Error(`Missing intrinsic getter ${String(key)}`);
  return getter;
}

function validatePeers(peers: DeckGlPeers): DeckGlPeers {
  const ScatterplotLayer = peers?.ScatterplotLayer;
  if (typeof ScatterplotLayer !== "function") {
    throw new HonuaDeckGlAdapterError("missing-peer", "DeckGlPeers.ScatterplotLayer must be a constructor.");
  }
  return Object.freeze({ ScatterplotLayer });
}

function normalizeLimits(input: Partial<DeckGlProjectionLimits> | undefined): DeckGlProjectionLimits {
  const limits = { ...DEFAULT_DECK_GL_PROJECTION_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new HonuaDeckGlAdapterError("invalid-data", `${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HonuaDeckGlAdapterError("invalid-data", `${field} must be a non-empty string.`);
  }
  return value;
}

function limitError(resource: string, actual: number, limit: number): HonuaDeckGlAdapterError {
  return new HonuaDeckGlAdapterError(
    "limit-exceeded",
    `Deck.gl projection ${resource} ${actual} exceeds limit ${limit}.`,
    { resource, actual, limit },
  );
}

function disposedError(operation: string): HonuaDeckGlAdapterError {
  return new HonuaDeckGlAdapterError("disposed", `Deck.gl adapter cannot ${operation} after dispose().`);
}

function asDisposalError(error: unknown): HonuaDeckGlAdapterError {
  return error instanceof HonuaDeckGlAdapterError && error.code === "dispose-failed"
    ? error
    : new HonuaDeckGlAdapterError("dispose-failed", "deck.gl host removal failed and can be retried.", undefined, {
        cause: error,
      });
}

function isSelectionScalar(value: unknown): value is string | number | bigint {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint";
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
