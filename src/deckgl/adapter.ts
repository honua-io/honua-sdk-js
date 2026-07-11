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

export const DEFAULT_DECK_GL_PROJECTION_LIMITS: DeckGlProjectionLimits = Object.freeze({
  maxRows: 1_000_000,
  maxAttributes: 32,
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
  if (!isRecord(module) || typeof module.ScatterplotLayer !== "function") {
    throw new HonuaDeckGlAdapterError(
      "missing-peer",
      'The loaded "@deck.gl/layers" module does not export ScatterplotLayer.',
      { package: "@deck.gl/layers", export: "ScatterplotLayer" },
    );
  }
  return Object.freeze({ ScatterplotLayer: module.ScatterplotLayer as DeckGlPeers["ScatterplotLayer"] });
}

export interface CreateDeckGlAdapterOptions {
  readonly peers: DeckGlPeers;
  readonly limits?: Partial<DeckGlProjectionLimits>;
}

export function createDeckGlAdapter(options: CreateDeckGlAdapterOptions): DeckGlAdapter {
  const peers = validatePeers(options.peers);
  const limits = normalizeLimits(options.limits);
  const mounted = new Set<DeckGlMountedProjection>();
  let disposed = false;

  return {
    capabilities: DECK_GL_CAPABILITIES,
    limits,
    get disposed() {
      return disposed;
    },
    project(request) {
      if (disposed) throw disposedError("project");
      return createProjection(peers, limits, request, mounted, () => disposed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const handle of [...mounted]) {
        try {
          handle.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      mounted.clear();
      if (errors.length > 0)
        throw new AggregateError(errors, "One or more deck.gl layer hosts failed during disposal.");
    },
  };
}

function createProjection(
  peers: DeckGlPeers,
  limits: DeckGlProjectionLimits,
  request: DeckGlProjectionRequest,
  ownedMounts: Set<DeckGlMountedProjection>,
  adapterDisposed: () => boolean,
): DeckGlProjection {
  if (request.layer !== "scatterplot") {
    throw new HonuaDeckGlAdapterError(
      "unsupported-layer",
      `Layer "${request.layer}" is not supported by contract v1.0.`,
      {
        layer: request.layer,
        supported: ["scatterplot"],
      },
    );
  }
  validateNonEmpty(request.layerId, "layerId");
  validateNonEmpty(request.identity.sourceId, "identity.sourceId");
  validateNonEmpty(request.identity.planId, "identity.planId");
  const metrics = validateBinaryData(request, limits);
  const props = request.props ?? {};
  for (const reserved of ["id", "data", "pickable"] as const) {
    if (Object.hasOwn(props, reserved)) {
      throw new HonuaDeckGlAdapterError("invalid-data", `props.${reserved} is reserved by the Honua adapter.`, {
        property: reserved,
      });
    }
  }

  const binaryData = Object.freeze({
    length: request.data.length,
    attributes: Object.freeze(
      Object.fromEntries(
        Object.entries(request.data.attributes).map(([name, attribute]) => [name, freezeAttribute(attribute)]),
      ),
    ),
  });
  const layer = new peers.ScatterplotLayer({ ...props, id: request.layerId, data: binaryData, pickable: true });
  const identity = request.identity;

  return Object.freeze({
    contractVersion: DECK_GL_ADAPTER_CONTRACT_VERSION,
    layer,
    metrics,
    diagnostic: Object.freeze({
      strategy: "gpu-binary" as const,
      fidelity: "exact-input" as const,
      precision: "input-array" as const,
      fallback: "none" as const,
      message: "Typed-array views are forwarded to deck.gl without SDK payload copies.",
    }),
    selectionForPick(index: number): DeckGlPickedSelection {
      if (!Number.isSafeInteger(index) || index < 0 || index >= request.data.length) {
        throw new HonuaDeckGlAdapterError(
          "invalid-data",
          `Pick index ${index} is outside [0, ${request.data.length}).`,
          {
            index,
            rows: request.data.length,
          },
        );
      }
      const featureId = identity.featureIds[index];
      if (!isSelectionScalar(featureId)) {
        throw new HonuaDeckGlAdapterError("invalid-data", `identity.featureIds[${index}] is not a stable scalar.`, {
          index,
        });
      }
      return Object.freeze({
        sourceId: identity.sourceId,
        planId: identity.planId,
        ...(identity.sourceVersion === undefined ? {} : { sourceVersion: identity.sourceVersion }),
        featureId,
        rowIndex: index,
      });
    },
    mount(host: DeckGlLayerHost): DeckGlMountedProjection {
      if (adapterDisposed()) throw disposedError("mount a projection");
      if (!host || typeof host.addLayer !== "function" || typeof host.removeLayer !== "function") {
        throw new HonuaDeckGlAdapterError(
          "invalid-data",
          "A deck.gl layer host must implement addLayer and removeLayer.",
        );
      }
      host.addLayer(layer);
      let mountDisposed = false;
      const mountedHandle: DeckGlMountedProjection = {
        layer,
        get disposed() {
          return mountDisposed;
        },
        dispose() {
          if (mountDisposed) return;
          mountDisposed = true;
          ownedMounts.delete(mountedHandle);
          host.removeLayer(layer);
        },
      };
      ownedMounts.add(mountedHandle);
      return mountedHandle;
    },
  });
}

function validateBinaryData(request: DeckGlProjectionRequest, limits: DeckGlProjectionLimits): DeckGlProjectionMetrics {
  const { data, identity } = request;
  if (!Number.isSafeInteger(data.length) || data.length < 0) {
    throw new HonuaDeckGlAdapterError("invalid-data", "data.length must be a non-negative safe integer.");
  }
  if (data.length > limits.maxRows) throw limitError("rows", data.length, limits.maxRows);
  if (identity.featureIds.length !== data.length) {
    throw new HonuaDeckGlAdapterError("invalid-data", "identity.featureIds length must equal data.length.", {
      rows: data.length,
      featureIds: identity.featureIds.length,
    });
  }
  const entries = Object.entries(data.attributes);
  if (entries.length === 0)
    throw new HonuaDeckGlAdapterError("invalid-data", "At least one binary attribute is required.");
  if (entries.length > limits.maxAttributes) throw limitError("attributes", entries.length, limits.maxAttributes);
  if (!("getPosition" in data.attributes)) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      'Scatterplot projection requires a "getPosition" binary attribute.',
    );
  }

  const backings = new Set<ArrayBufferLike>();
  let logicalViewBytes = 0;
  let uniqueBackingBytes = 0;
  for (const [name, attribute] of entries) {
    if (!name || !isTypedArray(attribute.value)) {
      throw new HonuaDeckGlAdapterError("invalid-data", `Attribute "${name}" must use a typed-array view.`);
    }
    if (!Number.isInteger(attribute.size) || attribute.size < 1 || attribute.size > 4) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" size must be an integer from 1 through 4.`,
      );
    }
    const offset = attribute.offset ?? 0;
    const stride = attribute.stride ?? attribute.size * attribute.value.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(stride) || stride <= 0) {
      throw new HonuaDeckGlAdapterError("invalid-data", `Attribute "${name}" has an invalid offset or stride.`);
    }
    if (
      data.length > 0 &&
      offset + (data.length - 1) * stride + attribute.size * attribute.value.BYTES_PER_ELEMENT >
        attribute.value.byteLength
    ) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        `Attribute "${name}" cannot address ${data.length} rows within its view.`,
      );
    }
    logicalViewBytes += attribute.value.byteLength;
    if (!backings.has(attribute.value.buffer)) {
      backings.add(attribute.value.buffer);
      uniqueBackingBytes += attribute.value.buffer.byteLength;
      if (uniqueBackingBytes > limits.maxBackingBytes) {
        throw limitError("unique backing bytes", uniqueBackingBytes, limits.maxBackingBytes);
      }
    }
  }
  return Object.freeze({
    rows: data.length,
    attributes: entries.length,
    logicalViewBytes,
    uniqueBackingBytes,
    copiedBytes: 0,
  });
}

function freezeAttribute(attribute: DeckGlBinaryAttribute): DeckGlBinaryAttribute {
  return Object.freeze({
    value: attribute.value,
    size: attribute.size,
    ...(attribute.offset === undefined ? {} : { offset: attribute.offset }),
    ...(attribute.stride === undefined ? {} : { stride: attribute.stride }),
    ...(attribute.normalized === undefined ? {} : { normalized: attribute.normalized }),
  });
}

function validatePeers(peers: DeckGlPeers): DeckGlPeers {
  if (!peers || typeof peers.ScatterplotLayer !== "function") {
    throw new HonuaDeckGlAdapterError("missing-peer", "DeckGlPeers.ScatterplotLayer must be a constructor.");
  }
  return peers;
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

function validateNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HonuaDeckGlAdapterError("invalid-data", `${field} must be a non-empty string.`);
  }
}

function limitError(resource: string, actual: number, limit: number): HonuaDeckGlAdapterError {
  return new HonuaDeckGlAdapterError(
    "limit-exceeded",
    `Deck.gl projection ${resource} ${actual} exceeds limit ${limit}.`,
    {
      resource,
      actual,
      limit,
    },
  );
}

function disposedError(operation: string): HonuaDeckGlAdapterError {
  return new HonuaDeckGlAdapterError("disposed", `Deck.gl adapter cannot ${operation} after dispose().`);
}

function isTypedArray(
  value: unknown,
): value is Exclude<ArrayBufferView, DataView> & { readonly BYTES_PER_ELEMENT: number } {
  return ArrayBuffer.isView(value) && !(value instanceof DataView) && "BYTES_PER_ELEMENT" in value;
}

function isSelectionScalar(value: unknown): value is string | number | bigint {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
