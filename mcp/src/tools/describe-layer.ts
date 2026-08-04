import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { withCapabilityHonesty } from "../neutral/errors.js";
import { type ResolvedSource, ogcLayoutFor, resolveSource, sourceRefFields } from "../neutral/source-ref.js";

/**
 * `honua_describe_layer` — protocol-neutral source description (#1005).
 *
 * The envelope is the same for every protocol: the neutral source reference,
 * its protocol, the capabilities the runtime will actually honor, and a field
 * schema. Where the schema comes from is protocol-specific (GeoServices layer
 * metadata, an OGC collection + its queryables); the shape the agent reads is
 * not. Protocols with no metadata document report `schemaAvailable: false`
 * with a reason instead of an empty field list, which would read as "this
 * source has no attributes".
 */
export const schema = z.object({
  ...sourceRefFields,
});

export type Input = z.infer<typeof schema>;

interface DescribeEnvelope {
  name: string | null;
  description: string | null;
  geometryType: string | null;
  fields: Array<{ name: string; type: string | null; alias: string }>;
  extent: unknown;
  spatialReference: unknown;
  relationships: unknown;
  timeField?: string | null;
  schemaAvailable: boolean;
  schemaReason?: string;
}

async function describeGeoServices(client: HonuaClient, resolved: ResolvedSource): Promise<DescribeEnvelope> {
  const { serviceId, layerId } = resolved.descriptor.locator;
  const meta = await client.getLayerMetadata(serviceId as string, layerId as number);
  return {
    name: meta.name ?? null,
    description: meta.description ?? null,
    geometryType: meta.geometryType ?? null,
    fields: (meta.fields ?? []).map((f) => ({ name: f.name, type: f.type ?? null, alias: f.alias ?? f.name })),
    extent: meta.extent ?? null,
    spatialReference: meta.spatialReference ?? null,
    relationships: meta.relationships ?? [],
    schemaAvailable: true,
  };
}

function bboxToExtent(bbox: readonly number[] | undefined): Record<string, number> | null {
  if (!bbox || bbox.length < 4) return null;
  const [xmin, ymin, xmax, ymax] = bbox;
  return { xmin, ymin, xmax, ymax };
}

async function describeOgcCollection(client: HonuaClient, resolved: ResolvedSource): Promise<DescribeEnvelope> {
  const collectionId = resolved.descriptor.locator.collectionId as string;
  const layout = await ogcLayoutFor(client, resolved.ref.layout);
  const request = { collectionId, ...(layout ? { layout } : {}) };
  const meta =
    resolved.descriptor.protocol === "ogc-records"
      ? await client.getOgcRecordCollection(request)
      : await client.getOgcCollection(request);

  let fields: DescribeEnvelope["fields"] = [];
  let schemaAvailable = true;
  let schemaReason: string | undefined;
  try {
    const queryables = await client.getOgcQueryables(request);
    fields = Object.entries(queryables.properties ?? {}).map(([name, property]) => ({
      name,
      type: property.type ?? null,
      alias: property.title ?? name,
    }));
    if (fields.length === 0) {
      schemaAvailable = false;
      schemaReason = "the collection advertises no queryable properties.";
    }
  } catch (error) {
    schemaAvailable = false;
    schemaReason = `queryables are not published by this endpoint: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  const temporal = meta.extent?.temporal?.interval?.[0];
  return {
    name: meta.title ?? meta.id ?? collectionId,
    description: meta.description ?? null,
    geometryType: null,
    fields,
    extent: bboxToExtent(meta.extent?.spatial?.bbox?.[0]),
    spatialReference: meta.extent?.spatial?.crs ?? meta.crs?.[0] ?? null,
    relationships: [],
    ...(temporal ? { timeField: null } : {}),
    schemaAvailable,
    ...(schemaReason ? { schemaReason } : {}),
  };
}

function describeFromDescriptorOnly(resolved: ResolvedSource): DescribeEnvelope {
  return {
    name: resolved.ref.address,
    description: null,
    geometryType: null,
    fields: [],
    extent: null,
    spatialReference: null,
    relationships: [],
    schemaAvailable: false,
    schemaReason: `protocol "${resolved.descriptor.protocol}" publishes no schema document this server can read without a discovery pass; query the source and inspect the returned attributes instead.`,
  };
}

export async function execute(client: HonuaClient, input: Input) {
  return withCapabilityHonesty(async () => {
    const resolved = resolveSource(client, input);
    const protocol = resolved.descriptor.protocol;
    const envelope =
      protocol === "geoservices-feature-service" || protocol === "geoservices-map-service" || protocol === "grpc"
        ? await describeGeoServices(client, resolved)
        : protocol === "ogc-features" || protocol === "ogc-records"
          ? await describeOgcCollection(client, resolved)
          : describeFromDescriptorOnly(resolved);

    return jsonText({
      source: resolved.ref.ref,
      protocol,
      capabilities: [...resolved.source.capabilities].sort(),
      ...envelope,
      // Retained for clients written against the pre-#1005 shape.
      id: resolved.descriptor.locator.layerId ?? resolved.ref.address,
    });
  });
}
