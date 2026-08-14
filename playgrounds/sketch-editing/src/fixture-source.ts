import {
  type AttachmentApi,
  type EditEnvelope,
  type EditResult,
  type Source,
  type SourceDescriptor,
  capabilities,
} from "@honua/sdk-js/contract";

export interface ParcelAttributes extends Record<string, unknown> {
  name: string;
  zone: string;
}

/** Deterministic harbor-district parcels: snap sources and map context. */
export const FIXTURE_PARCELS = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 101,
      properties: { name: "Pier 2 pump station", zone: "utility" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-157.871, 21.3075],
            [-157.8685, 21.3075],
            [-157.8685, 21.3095],
            [-157.871, 21.3095],
            [-157.871, 21.3075],
          ],
        ],
      },
    },
    {
      type: "Feature",
      id: 102,
      properties: { name: "Harbor corridor", zone: "transport" },
      geometry: {
        type: "LineString",
        coordinates: [
          [-157.874, 21.306],
          [-157.8655, 21.306],
        ],
      },
    },
  ],
} as const;

export interface AppliedEditRecord {
  readonly envelope: EditEnvelope<ParcelAttributes>;
  readonly result: EditResult;
}

/**
 * In-memory fixture Source for the mock lane: `applyEdits` assigns
 * server-style ids and records every envelope so the demo can prove edits
 * land through the contract edit-session path unchanged.
 */
export function createFixtureParcelSource(): {
  source: Source<ParcelAttributes>;
  applied: readonly AppliedEditRecord[];
} {
  const applied: AppliedEditRecord[] = [];
  let nextId = 200;

  const descriptor: SourceDescriptor = {
    id: "harbor-parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://fixture.local/", serviceId: "HarborParcels", layerId: 0 },
    capabilities: capabilities(["query", "applyEdits"]),
    schema: {
      primaryKey: "OBJECTID",
      fields: [
        { name: "name", type: "string" },
        { name: "zone", type: "string" },
      ],
    },
  };

  const emptyResult = { features: [], exceededTransferLimit: false };

  const source = {
    descriptor,
    capabilities: descriptor.capabilities,
    async query() {
      return emptyResult;
    },
    async queryAll() {
      return emptyResult;
    },
    async queryAggregate() {
      return emptyResult;
    },
    async queryExtent() {
      return { extent: null };
    },
    stream() {
      return emptyStream();
    },
    async queryObjectIds() {
      return [];
    },
    async applyEdits(envelope: EditEnvelope<ParcelAttributes>): Promise<EditResult> {
      const result: EditResult = {
        added: (envelope.adds ?? []).map(() => ({ id: nextId++, success: true })),
        updated: (envelope.updates ?? []).map((update) => ({ id: update.id ?? nextId++, success: true })),
        deleted: (envelope.deletes ?? []).map((id) => ({ id, success: true })),
      };
      applied.push({ envelope, result });
      return result;
    },
    async queryRelated(request: { sourceIds: readonly unknown[] }) {
      return { groups: request.sourceIds.map((sourceId: unknown) => ({ sourceId, features: [] })) };
    },
    attachments: unsupportedAttachments(),
    protocol() {
      return undefined;
    },
    adapter() {
      return undefined;
    },
  } as unknown as Source<ParcelAttributes>;

  return { source, applied };
}

async function* emptyStream() {
  // deterministic fixture: streaming yields no rows
}

function unsupportedAttachments(): AttachmentApi {
  const unsupported = async () => {
    throw new Error("attachments are not part of this fixture");
  };
  return { list: unsupported, add: unsupported, update: unsupported, delete: unsupported } as unknown as AttachmentApi;
}
