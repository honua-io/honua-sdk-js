import { NORTHSTAR_CORPUS } from "./northstar-corpus.js";
import { OGC_CORPUS } from "./ogc-corpus.js";
import { OPERATOR_CORPUS } from "./operator-corpus.js";
import { STANDALONE_CORPUS } from "./standalone-corpus.js";
import type { Scenario } from "./types.js";

/**
 * Held-out corpus of GIS workflows for the cross-model eval (honua-server #1956).
 *
 * Each scenario is a natural-language GIS task plus declarative success criteria.
 * The `script` is the "ideal client" tool trajectory the deterministic offline
 * driver follows; live LLM drivers (Claude, GPT) plan their own calls from the
 * prompt and the advertised tool catalog. Criteria are graded identically across
 * all drivers, so the same corpus measures any client against any workflow.
 *
 * Tool/argument shapes target the canonical honua MCP catalog and resolve
 * against the offline fixture backend (service "Parks", layer 0).
 */
export const CORPUS: Scenario[] = [
  {
    id: "discover-services",
    title: "Discover available feature services",
    category: "discovery",
    prompt: "I'm new to this server. What feature services are available to query? Just list them.",
    criteria: {
      requiredTools: ["honua_list_services"],
      answerMustInclude: ["Parks"],
    },
    script: [{ tool: "honua_list_services", args: {} }],
  },
  {
    id: "inspect-layer-schema",
    title: "Inspect a layer's schema before querying",
    category: "grounding",
    prompt:
      "Before I query the Parks service, show me the schema of its first layer (layer 0) — the fields and geometry type.",
    criteria: {
      requiredTools: ["honua_describe_layer"],
      answerMustInclude: ["OBJECTID"],
    },
    script: [{ tool: "honua_describe_layer", args: { serviceId: "Parks", layerId: 0 } }],
  },
  {
    id: "count-then-query",
    title: "Check cardinality, then fetch a sample",
    category: "query",
    prompt: "How many features are in the Parks service layer 0? Then show me a couple of them.",
    criteria: {
      requiredTools: ["honua_count_features", "honua_query_features"],
      expectedToolSequence: ["honua_count_features", "honua_query_features"],
      answerMustInclude: ["Park A"],
    },
    script: [
      { tool: "honua_count_features", args: { serviceId: "Parks", layerId: 0 } },
      { tool: "honua_query_features", args: { serviceId: "Parks", layerId: 0, limit: 2 } },
    ],
  },
  {
    id: "discover-then-query",
    title: "End-to-end discover → query",
    category: "multi-step",
    prompt:
      "I don't know what's on this server. Find a feature service and show me a few features from one of its layers.",
    criteria: {
      requiredTools: ["honua_list_services", "honua_query_features"],
      expectedToolSequence: ["honua_list_services", "honua_query_features"],
      answerMustInclude: ["Park"],
    },
    script: [
      { tool: "honua_list_services", args: {} },
      { tool: "honua_query_features", args: { serviceId: "Parks", layerId: 0, limit: 2 } },
    ],
  },
  {
    id: "aggregate-statistic",
    title: "Compute an aggregate statistic",
    category: "analysis",
    prompt: "What is the average of the VALUE field for the Parks service, layer 0?",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["statistics"],
    },
    script: [
      {
        tool: "honua_statistics",
        args: { serviceId: "Parks", layerId: 0, statisticType: "avg", onField: "VALUE" },
      },
    ],
  },
  {
    id: "spatial-extent",
    title: "Get the spatial extent of a layer",
    category: "query",
    prompt: "What is the bounding box / spatial extent of the Parks service, layer 0?",
    criteria: {
      requiredTools: ["honua_get_extent"],
      answerMustInclude: ["extent"],
    },
    script: [{ tool: "honua_get_extent", args: { serviceId: "Parks", layerId: 0 } }],
  },
  {
    id: "capability-gap",
    title: "Explain a capability gap honestly",
    category: "grounding",
    prompt: "Can I run an attribute query against a WMTS source on this platform? If not, what should I do instead?",
    criteria: {
      requiredTools: ["honua_explain_capability_gap"],
      answerMustInclude: ["explanation"],
    },
    script: [
      {
        tool: "honua_explain_capability_gap",
        args: { capability: "query", protocol: "wmts" },
      },
    ],
  },
];

/**
 * Select the corpus to run from the environment (honua-server #1956).
 *
 * The default `analyst` corpus targets the in-process SDK fixture surface and is
 * the CI control. `operator` selects {@link OPERATOR_CORPUS} for live runs against
 * the honua-server operator MCP surface; `northstar` selects {@link NORTHSTAR_CORPUS},
 * the three P1-gate workflows (also live-gated); `all` runs every corpus
 * back-to-back. Selection is case-insensitive and falls back to the analyst corpus
 * for any unset/unknown value so CI behavior is unchanged unless `HONUA_EVAL_CORPUS`
 * is set explicitly.
 */
export function resolveCorpus(env: NodeJS.ProcessEnv = process.env): Scenario[] {
  switch ((env.HONUA_EVAL_CORPUS ?? "").trim().toLowerCase()) {
    case "operator":
      return OPERATOR_CORPUS;
    case "northstar":
      return NORTHSTAR_CORPUS;
    case "standalone":
      return STANDALONE_CORPUS;
    case "ogc":
      return OGC_CORPUS;
    case "all":
      // `all` spans the Honua-surface corpora only. The platform-free standalone
      // corpus targets a DIFFERENT surface (a plain FeatureServer fixture) and is
      // selected explicitly via `standalone`; mixing it here would run its
      // census-specific scenarios against an operator surface.
      return [...CORPUS, ...OPERATOR_CORPUS, ...NORTHSTAR_CORPUS];
    default:
      return CORPUS;
  }
}

/**
 * Whether a corpus selection targets the PLATFORM-FREE standalone surface (a plain
 * public FeatureServer fixture) rather than the Honua operator/analyst surface.
 * The offline runner uses this to pick the census fixture client so the standalone
 * corpus resolves against real recorded non-Honua data.
 */
export function isStandaloneCorpus(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HONUA_EVAL_CORPUS ?? "").trim().toLowerCase() === "standalone";
}

/**
 * Whether a corpus selection targets the NON-GeoServices surface (issue #1005) —
 * a plain OGC API Features endpoint replayed from recorded pygeoapi collections.
 * The offline runner uses this to pick the OGC fixture client, on which every
 * GeoServices entry point rejects.
 */
export function isOgcCorpus(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HONUA_EVAL_CORPUS ?? "").trim().toLowerCase() === "ogc";
}
