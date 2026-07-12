/** Compile-only proof of the final root connect -> query -> explain -> mount workflow. */
import {
  type Query,
  type SourceToMapLibreMap,
  connect,
  envelope,
  explainQuery,
  mountSourceToMapLibre,
} from "@honua/sdk-js";

declare const map: SourceToMapLibreMap;

const connection = await connect({
  endpoint: "https://example.test/ogc",
  protocol: "ogc-features",
  authorizationScopeFingerprint: "anonymous",
});
const source = connection.source<{ status: string }>();
const query: Query<{ status: string }> = {
  where: "status = 'open'",
  spatialFilter: envelope(-158.5, 21.2, -157.6, 21.7),
  pagination: { limit: 100 },
};

const plan = explainQuery({ descriptor: source.descriptor, query });
const mounted = await mountSourceToMapLibre(map, source, plan);
mounted.dispose();

// Headless callers may use executeQueryPlan(plan, source) instead of mounting;
// it is an alternative terminal path, not an additional step before mount.
