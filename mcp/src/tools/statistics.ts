import type { HonuaClient } from "@honua/sdk-js";
import type { AggregationFn } from "@honua/sdk-js/contract";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { withCapabilityHonesty } from "../neutral/errors.js";
import { queryFilterFields, toQuery } from "../neutral/query.js";
import { projectDegraded } from "../neutral/result.js";
import { isGeoServicesProtocol, resolveSource, sourceRefFields } from "../neutral/source-ref.js";

/**
 * `honua_statistics` — protocol-neutral aggregation (#1005).
 *
 * Lowers onto the canonical `AggregationSpec`, which GeoServices serves with
 * `outStatistics` and which OGC API Features (no server-side aggregation)
 * serves client-side over the returned page with an explicit `degraded` reason.
 * The reason is reported in the result rather than dropped, so a page-scoped
 * aggregate is never mistaken for an authoritative one.
 */
export const schema = z.object({
  ...sourceRefFields,
  ...queryFilterFields,
  statisticType: z
    .enum(["count", "sum", "avg", "min", "max", "stddev", "var"])
    .describe("The aggregate function to compute."),
  onField: z.string().describe("The field to compute the statistic on."),
  groupBy: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe("Field(s) to group results by."),
});

export type Input = z.infer<typeof schema>;

function normalizeGroupBy(groupBy: Input["groupBy"]): string[] | undefined {
  if (groupBy === undefined) return undefined;
  const fields = (Array.isArray(groupBy) ? groupBy : groupBy.split(",")).map((f) => f.trim()).filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

export async function execute(client: HonuaClient, input: Input) {
  return withCapabilityHonesty(async () => {
    const resolved = resolveSource(client, input);
    const base = toQuery(input, { protocol: resolved.descriptor.protocol, paginate: false });
    // GeoServices rejects an `outStatistics` query that carries no `where`;
    // every other protocol treats "no filter" as "all records". Supplying the
    // tautology keeps the neutral "omit the filter ⇒ aggregate everything"
    // contract true on Esri endpoints.
    if (isGeoServicesProtocol(resolved.descriptor.protocol) && base.filter === undefined && base.where === undefined) {
      base.where = "1=1";
    }
    const groupBy = normalizeGroupBy(input.groupBy);
    const alias = `${input.statisticType}_${input.onField}`;

    const result = await resolved.source.queryAggregate({
      ...base,
      returnGeometry: false,
      aggregation: {
        ...(groupBy ? { groupBy } : {}),
        metrics: [{ fn: input.statisticType as AggregationFn, field: input.onField, alias }],
      },
    });

    const degraded = projectDegraded(result.degraded);
    return jsonText({
      source: resolved.ref.ref,
      protocol: resolved.descriptor.protocol,
      statistic: alias,
      statistics: (result.aggregateRows ?? []).map((attributes) => ({ attributes })),
      ...(degraded ? { degraded } : {}),
    });
  });
}
