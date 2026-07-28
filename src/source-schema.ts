/**
 * Focused experimental SourceSchemaV2 runtime and opt-in discovery wrapper.
 *
 * This subpath intentionally owns the schema validator and protocol
 * normalizers so ordinary root, browser, `/honua`, `/contract`, and query
 * planner imports do not pay for the pinned PROJJSON validator.
 *
 * @experimental
 * @module
 */

import {
  geoParquetSourceSchemaV2,
  geoServicesSourceSchemaV2,
  odataSourceSchemaV2,
  wmsSourceSchemaV2,
  wmtsSourceSchemaV2,
} from "./connect-schema.js";
import { connectWithSourceSchemaProjection } from "./connect.js";
import type { ConnectOptions, HonuaConnection, HonuaConnectionInspection } from "./connect.js";
import type { SourceDiscoveryInspection } from "./contract/discovery.js";
import { parseSourceSchemaV2 } from "./contract/schema.js";
import type { SourceSchemaV2 } from "./contract/schema.js";
import type { CapabilityAwareSource, Dataset, SourceDescriptor, SourceId } from "./contract/types.js";
import { SOURCE_SCHEMA_V2_CONNECT_PROJECTION } from "./source-schema-connect-projection.js";

export {
  geoParquetSourceSchemaV2,
  geoServicesSourceSchemaV2,
  odataSourceSchemaV2,
  wmsSourceSchemaV2,
  wmtsSourceSchemaV2,
} from "./connect-schema.js";
export type { SchemaNormalizationContext } from "./connect-schema.js";

export {
  SOURCE_SCHEMA_V2_FINGERPRINT_DOMAIN,
  SOURCE_SCHEMA_STATE_FINGERPRINT_DOMAIN,
  SOURCE_SCHEMA_V2_KIND,
  SOURCE_SCHEMA_V2_VERSION,
  cloneSourceSchemaV2,
  createSourceSchemaV2,
  parseSourceSchemaV2,
  serializeSourceSchemaV2,
  sourceSchemaIdentity,
  schemaStateBindingFingerprint,
  unavailableSchemaIdentity,
} from "./contract/schema.js";
export type * from "./contract/schema.js";

/** Descriptor refinement returned by the focused, fully validated connection path. */
export type SourceDescriptorWithSchemaV2 = Omit<SourceDescriptor, "schemaV2"> & {
  readonly schemaV2?: SourceSchemaV2;
};

/** Source refinement whose descriptor exposes the complete validated schema. */
export type SourceWithSchemaV2<T = Record<string, unknown>> = Omit<CapabilityAwareSource<T>, "descriptor"> & {
  readonly descriptor: SourceDescriptorWithSchemaV2;
};

/** Dataset refinement whose descriptors expose complete validated schemas. */
export type DatasetWithSourceSchemaV2 = Omit<Dataset, "sourceDescriptors" | "source"> & {
  readonly sourceDescriptors: ReadonlyArray<SourceDescriptorWithSchemaV2>;
  source<T = Record<string, unknown>>(id: SourceId): SourceWithSchemaV2<T> | undefined;
};

/** Discovery inspection refinement for the focused schema connection path. */
export type SourceDiscoveryInspectionWithSchemaV2 = Omit<SourceDiscoveryInspection, "descriptor"> & {
  readonly descriptor: SourceDescriptorWithSchemaV2;
};

/** Connection inspection refinement for the focused schema connection path. */
export type HonuaConnectionInspectionWithSourceSchemaV2 = Omit<HonuaConnectionInspection, "sources"> & {
  readonly sources: readonly SourceDiscoveryInspectionWithSchemaV2[];
};

/** Connection returned by {@link connectWithSourceSchemaV2}. */
export type HonuaConnectionWithSourceSchemaV2 = Omit<HonuaConnection, "dataset" | "inspection" | "source"> & {
  readonly dataset: DatasetWithSourceSchemaV2;
  readonly inspection: HonuaConnectionInspectionWithSourceSchemaV2;
  source<T = Record<string, unknown>>(id?: SourceId): SourceWithSchemaV2<T>;
};

/**
 * Build the transitional planner context for a validated schema descriptor.
 *
 * Generic query planning intentionally does not trust a caller-constructed
 * `schemaV2` envelope. This focused helper reparses the complete value and
 * supplies its verified fingerprint through the existing `schemaVersion`
 * context until descriptor-native plan identity lands.
 */
export function sourceSchemaV2QueryContext(
  descriptor: Pick<SourceDescriptor, "schemaV2">,
): Readonly<{ schemaVersion?: string }> {
  if (descriptor.schemaV2 === undefined) return Object.freeze({});
  return Object.freeze({ schemaVersion: parseSourceSchemaV2(descriptor.schemaV2).fingerprint });
}

/**
 * Run the normal one-pass connection discovery with SourceSchemaV2 enrichment.
 * Metadata is fetched once; the focused projection participates in cache
 * identity and revalidates every cached schema fingerprint before use.
 */
export function connectWithSourceSchemaV2(options: ConnectOptions): Promise<HonuaConnectionWithSourceSchemaV2> {
  return connectWithSourceSchemaProjection(
    options,
    SOURCE_SCHEMA_V2_CONNECT_PROJECTION,
  ) as Promise<HonuaConnectionWithSourceSchemaV2>;
}
