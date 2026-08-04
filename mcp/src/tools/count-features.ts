import type { HonuaClient } from "@honua/sdk-js";
import { HonuaCapabilityNotSupportedError } from "@honua/sdk-js";
import type { CapabilityAwareSource, Query } from "@honua/sdk-js/contract";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { withCapabilityHonesty } from "../neutral/errors.js";
import { queryFilterFields, toQuery } from "../neutral/query.js";
import { projectDegraded } from "../neutral/result.js";
import { resolveSource, sourceRefFields } from "../neutral/source-ref.js";

/**
 * `honua_count_features` — protocol-neutral cardinality check (#1005).
 *
 * There is no single "count" verb across the protocols, so the count is taken
 * from whichever canonical path the source's declared capabilities support:
 *
 *  1. `queryExtent` (GeoServices, WFS, gRPC) returns an exact server count
 *     alongside the envelope in one round trip.
 *  2. otherwise a single-record `query` reports `totalCount`, which is where
 *     OGC API Features / STAC / OData carry `numberMatched`.
 *
 * When neither path yields a number the tool refuses with a structured
 * capability error rather than reporting `0`.
 */
export const schema = z.object({
  ...sourceRefFields,
  ...queryFilterFields,
});

export type Input = z.infer<typeof schema>;

interface CountOutcome {
  count: number;
  strategy: "queryExtent" | "totalCount";
  degraded: ReturnType<typeof projectDegraded>;
}

/** Resolve a feature count through the canonical `Source` surface. */
export async function countThroughSource(
  source: CapabilityAwareSource,
  query: Query,
  protocol: string,
  sourceId: string,
): Promise<CountOutcome> {
  if (source.capabilities.has("queryExtent")) {
    const extent = await source.queryExtent(query);
    if (typeof extent.count === "number" && Number.isFinite(extent.count)) {
      return { count: extent.count, strategy: "queryExtent", degraded: undefined };
    }
  }

  const probe: Query = { ...query, returnGeometry: false, pagination: { ...query.pagination, limit: 1 } };
  const result = await source.query(probe);
  if (typeof result.totalCount === "number" && Number.isFinite(result.totalCount)) {
    return { count: result.totalCount, strategy: "totalCount", degraded: projectDegraded(result.degraded) };
  }

  throw new HonuaCapabilityNotSupportedError("count", protocol, sourceId);
}

export async function execute(client: HonuaClient, input: Input) {
  return withCapabilityHonesty(async () => {
    const resolved = resolveSource(client, input);
    const query = toQuery(input, { protocol: resolved.descriptor.protocol, paginate: false });
    const outcome = await countThroughSource(
      resolved.source,
      query,
      resolved.descriptor.protocol,
      resolved.descriptor.id,
    );

    return jsonText({
      source: resolved.ref.ref,
      protocol: resolved.descriptor.protocol,
      count: outcome.count,
      countStrategy: outcome.strategy,
      ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
    });
  });
}
