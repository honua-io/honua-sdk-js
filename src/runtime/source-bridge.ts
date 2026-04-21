/**
 * Translates `MapPackage.sourceBindings[]` (server shape) into SDK-side
 * `SourceDescriptor[]` consumed by `createDataset`, and keeps a parallel
 * record of MapLibre-native source entries that flow straight into the
 * composed style.
 *
 * Contract:
 *  - Protocol-backed bindings (`geoservices_*`, `ogc_features`, `wfs`,
 *    `wms`, `odata`) produce a `SourceDescriptor` whose locator mirrors
 *    the server's field shape verbatim per `docs/source-binding-alignment.md`.
 *  - MapLibre-native bindings (`vector_tile`, `raster_tile`) skip the
 *    contract pipeline and surface as MapLibre source entries.
 *  - `ogc_maps` / `ogc_tiles` project onto MapLibre-native sources
 *    (raster or vector) since the SDK does not model them as first-party
 *    data protocols.
 *  - `workspace_artifact` is deferred (no adapter); load fails with a
 *    clear `HonuaMapPackageError` stage="source-bind" so callers can
 *    detect missing server artifacts.
 *
 * @module
 */

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type SourceDescriptor,
  type SourceLocator,
} from "../contract/index.js";
import { HonuaMapPackageError } from "./errors.js";
import type {
  HonuaMapPackageLocator,
  HonuaMapPackageProtocol,
  HonuaMapPackageSourceBinding,
} from "./map-package.js";

/** One MapLibre-native source entry derived from a binding. */
export interface NativeMapLibreSourceEntry {
  sourceId: string;
  spec: { type: string; [key: string]: unknown };
  attribution?: string;
}

/** Result of projecting a package's source bindings. */
export interface SourceBridgeProjection {
  /** Protocol-backed descriptors destined for `createDataset`. */
  descriptors: SourceDescriptor[];
  /**
   * MapLibre-native source entries keyed by sourceId. These flow straight
   * into the composed style's `sources` map without going through
   * `Dataset`.
   */
  nativeSources: NativeMapLibreSourceEntry[];
  /** Binding filter expressions captured per source id. */
  filtersBySourceId: Map<string, string>;
}

/**
 * Project the bindings on a MapPackage into SDK contract descriptors and
 * MapLibre-native source entries. Throws `HonuaMapPackageError` for
 * bindings the runtime cannot route (unknown protocol, missing locator,
 * deferred `workspace_artifact`).
 */
export function projectSourceBindings(
  packageId: string | undefined,
  bindings: readonly HonuaMapPackageSourceBinding[],
): SourceBridgeProjection {
  const descriptors: SourceDescriptor[] = [];
  const nativeSources: NativeMapLibreSourceEntry[] = [];
  const filtersBySourceId = new Map<string, string>();
  const seen = new Set<string>();

  for (const binding of bindings) {
    if (seen.has(binding.sourceId)) {
      throw new HonuaMapPackageError(`duplicate sourceBinding id "${binding.sourceId}"`, {
        packageId,
        stage: "source-bind",
        detail: { sourceId: binding.sourceId },
      });
    }
    seen.add(binding.sourceId);

    if (binding.filter) {
      filtersBySourceId.set(binding.sourceId, binding.filter);
    }

    const mlNative = toMapLibreNativeSource(binding);
    if (mlNative) {
      nativeSources.push(mlNative);
      continue;
    }

    const sdkProtocol = toSdkProtocol(binding.protocol);
    if (!sdkProtocol) {
      throw new HonuaMapPackageError(
        `unsupported SourceBinding protocol "${binding.protocol}" on source "${binding.sourceId}"`,
        { packageId, stage: "source-bind", detail: { sourceId: binding.sourceId, protocol: binding.protocol } },
      );
    }

    descriptors.push({
      id: binding.sourceId,
      protocol: sdkProtocol,
      locator: toSourceLocator(packageId, binding),
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES[sdkProtocol],
      attribution: binding.attribution,
    });
  }

  return { descriptors, nativeSources, filtersBySourceId };
}

/**
 * Build the Honua custom-source spec (to be inserted into `style.sources`)
 * for a protocol-backed descriptor.
 */
export function toHonuaSourceSpec(descriptor: SourceDescriptor, filter?: string): { type: string; [key: string]: unknown } {
  switch (descriptor.protocol) {
    case "geoservices-feature-service": {
      const url = requireLocatorUrl(descriptor);
      return {
        type: "honua-feature-service",
        url,
        ...(filter ? { definitionExpression: filter } : {}),
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
    }
    case "geoservices-map-service": {
      const url = requireLocatorUrl(descriptor);
      return {
        type: "honua-map-service",
        url,
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
    }
    case "ogc-features": {
      const url = requireLocatorUrl(descriptor);
      return {
        type: "honua-ogc-features",
        url,
        ...(descriptor.locator.collectionId !== undefined
          ? { collectionId: String(descriptor.locator.collectionId) }
          : {}),
        ...(filter ? { filter } : {}),
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
    }
    default:
      return {
        type: `honua-${descriptor.protocol}`,
        ...descriptor.locator,
        ...(filter ? { filter } : {}),
        ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
      };
  }
}

function toSdkProtocol(protocol: HonuaMapPackageProtocol): Protocol | undefined {
  switch (protocol) {
    case "geoservices_feature_service":
      return "geoservices-feature-service";
    case "geoservices_map_service":
      return "geoservices-map-service";
    case "ogc_features":
      return "ogc-features";
    case "wfs":
      return "wfs";
    case "wms":
      return "wms";
    case "odata":
      return "odata";
    default:
      return undefined;
  }
}

function toMapLibreNativeSource(binding: HonuaMapPackageSourceBinding): NativeMapLibreSourceEntry | undefined {
  switch (binding.protocol) {
    case "vector_tile":
    case "ogc_tiles":
      return {
        sourceId: binding.sourceId,
        attribution: binding.attribution,
        spec: {
          type: "vector",
          ...(binding.locator.url ? { tiles: [binding.locator.url] } : {}),
          ...(binding.attribution ? { attribution: binding.attribution } : {}),
        },
      };
    case "raster_tile":
    case "ogc_maps":
      return {
        sourceId: binding.sourceId,
        attribution: binding.attribution,
        spec: {
          type: "raster",
          ...(binding.locator.url ? { tiles: [binding.locator.url] } : {}),
          ...(binding.attribution ? { attribution: binding.attribution } : {}),
        },
      };
    default:
      return undefined;
  }
}

function toSourceLocator(packageId: string | undefined, binding: HonuaMapPackageSourceBinding): SourceLocator {
  const loc = binding.locator;
  if (binding.protocol === "workspace_artifact") {
    throw new HonuaMapPackageError(
      `"workspace_artifact" binding on source "${binding.sourceId}" requires a server-side artifact resolver that is not yet wired`,
      { packageId, stage: "source-bind", detail: { sourceId: binding.sourceId, protocol: binding.protocol } },
    );
  }

  if (typeof loc.url !== "string" || loc.url.length === 0) {
    throw new HonuaMapPackageError(
      `SourceBinding "${binding.sourceId}" is missing locator.url`,
      { packageId, stage: "source-bind", detail: { sourceId: binding.sourceId, protocol: binding.protocol } },
    );
  }

  const locator: SourceLocator = { url: loc.url };
  if (loc.serviceId !== undefined) locator.serviceId = loc.serviceId;
  if (loc.layerId !== undefined) locator.layerId = loc.layerId;
  if (loc.collectionId !== undefined) locator.collectionId = loc.collectionId;
  if (loc.typeName !== undefined) locator.typeName = loc.typeName;
  if (loc.entitySet !== undefined) locator.entitySet = loc.entitySet;
  return locator;
}

function requireLocatorUrl(descriptor: SourceDescriptor): string {
  const url = descriptor.locator.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new HonuaMapPackageError(
      `descriptor for "${descriptor.id}" is missing locator.url`,
      { stage: "source-bind", detail: { sourceId: descriptor.id, protocol: descriptor.protocol } },
    );
  }
  return url;
}

/** Re-export the server-shape locator type so callers do not import a deep path. */
export type { HonuaMapPackageLocator };
