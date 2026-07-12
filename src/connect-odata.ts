/** Internal OData v4 `$metadata` (CSDL) projection for connect(). */

import type { ConnectDiscoverySourceSnapshot, ConnectOptions } from "./connect.js";
import type { DiscoveryCacheIdentity, DiscoveryCapabilityEvidence, DiscoveryProvenance } from "./contract/discovery.js";
import { type Capability, PROTOCOL_DEFAULT_CAPABILITIES, type SourceSchema } from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import { type HonuaOdataMetadata, odataFieldSchema } from "./core/odata.js";

/**
 * OData's canonical adapter surface. Discovery evidence is scoped to this
 * set so `resolveDiscoveryCapabilities` intersects endpoint evidence against
 * the exact operations the OData `Source` adapter can implement.
 */
const ODATA_ADAPTER_SCOPE: readonly Capability[] = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES.odata]);

export interface OdataDiscoveryResult {
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

/**
 * Discover every entity set advertised by an OData v4 service's CSDL
 * `$metadata` document and project each into a reviewed source snapshot.
 *
 * Capabilities are derived exclusively from the parsed metadata:
 *
 *  - `query` / `stream` — every declared entity set is readable over
 *    `$top` / `$skip` server-driven paging, so their presence in
 *    `$metadata` is positive metadata evidence.
 *  - `queryObjectIds` — requires a declared entity key; without one the
 *    canonical ids-only projection has no field to select.
 *  - `applyEdits` — advertised unless the CSDL `Capabilities.*` restriction
 *    annotations mark insert, update, and delete as all explicitly false
 *    (OData restriction annotations default to capable when absent). This
 *    mirrors the runtime OData adapter's `applyEdits` gate exactly, so the
 *    discovered descriptor and the live source agree.
 */
export async function discoverOdataSources(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  basePath: string,
  options: ConnectOptions,
): Promise<OdataDiscoveryResult> {
  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
  const metadata = await client.odata("", { basePath }).metadata(request);
  throwIfAborted(options.signal);

  const entitySetNames = Object.keys(metadata.entitySets);
  if (entitySetNames.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "OData $metadata advertised no entity sets.");
  }

  const retrievedAt = new Date().toISOString();
  const metadataUrl = `${identity.endpoint}/$metadata`;
  const validator = metadata.cache?.validator?.etag ?? metadata.cache?.validator?.lastModified;
  const provenance: readonly DiscoveryProvenance[] = Object.freeze([
    Object.freeze({ source: metadataUrl, retrievedAt, ...(validator ? { validator } : {}) }),
  ]);

  const sources = entitySetNames.map((name) =>
    discoveredOdataSourceSnapshot(identity.endpoint, name, metadata, provenance),
  );
  return Object.freeze({ retrievedAt, evidence: Object.freeze([]), sources: Object.freeze(sources) });
}

function discoveredOdataSourceSnapshot(
  endpoint: string,
  entitySet: string,
  metadata: HonuaOdataMetadata,
  provenance: readonly DiscoveryProvenance[],
): ConnectDiscoverySourceSnapshot {
  const typeName = metadata.entitySets[entitySet];
  const keys = (typeName ? metadata.keys[typeName] : undefined) ?? [];
  const advertised = metadata.capabilities[entitySet] ?? {};
  const writable = !(advertised.insert === false && advertised.update === false && advertised.delete === false);

  const capabilities: Capability[] = ["query", "stream"];
  if (keys.length > 0) capabilities.push("queryObjectIds");
  if (writable) capabilities.push("applyEdits");

  const fields = odataFieldSchema(metadata, entitySet);
  const schema: SourceSchema | undefined =
    fields.length > 0
      ? Object.freeze({
          fields: Object.freeze([...fields]),
          ...(keys.length === 1 ? { primaryKey: keys[0] } : {}),
        })
      : undefined;

  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze(capabilities),
      scope: ODATA_ADAPTER_SCOPE,
      provenance,
    }),
  ]);

  return Object.freeze({
    id: entitySet,
    locator: Object.freeze({ url: endpoint, entitySet }),
    title: entitySet,
    ...(schema ? { schema } : {}),
    evidence,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
