import type { HonuaClient } from "@honua/sdk-js";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { withCapabilityHonesty } from "../neutral/errors.js";
import { queryFilterFields, toQuery } from "../neutral/query.js";
import { resolveSource, sourceRefFields } from "../neutral/source-ref.js";

/**
 * `honua_get_extent` — protocol-neutral bounding box (#1005).
 *
 * Runs the canonical `Source.queryExtent()`. Protocols with no server-side
 * extent operation (OGC API Features, STAC, OData) answer from the collection's
 * declared extent under the degraded capability policy, and say so; protocols
 * that cannot answer at all refuse with a structured capability error.
 */
export const schema = z.object({
  ...sourceRefFields,
  ...queryFilterFields,
});

export type Input = z.infer<typeof schema>;

export async function execute(client: HonuaClient, input: Input) {
  return withCapabilityHonesty(async () => {
    const resolved = resolveSource(client, input);
    const query = toQuery(input, { protocol: resolved.descriptor.protocol, paginate: false });
    const { extent, count } = await resolved.source.queryExtent(query);

    return jsonText({
      source: resolved.ref.ref,
      protocol: resolved.descriptor.protocol,
      extent: extent ?? null,
      count: count ?? null,
      // An extent that did not come from a server-side extent operation is an
      // honest, but weaker, answer; name the capability so the caller can tell.
      extentCapability: resolved.source.capabilities.has("queryExtent") ? "server" : "declared-extent",
    });
  });
}
