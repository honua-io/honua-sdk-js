import { CENSUS_SERVICE_ID } from "../certification/census-data.js";
import type { Scenario } from "./types.js";

/**
 * PLATFORM-FREE (standalone) eval corpus — issue #369.
 *
 * 50+ GIS workflows run against a PLAIN public Esri FeatureServer (the recorded
 * US Census 2020 apportionment layer; see `certification/census-data.ts`) with
 * ZERO Honua-server surfaces. Unlike the analyst/operator corpora — which grade
 * mostly on tool trajectory (structural) — every scenario here carries a SEMANTIC
 * assertion: the answer must contain the correct feature count, the correct
 * geographic fact, the right tool choice for an ambiguous ask, or a clarifying
 * question when the request is ambiguous/unsupported. Because the fixture replays
 * real recorded data, a wrong number or a hallucinated place name FAILS.
 *
 * Grounded anchors (verified live against services.arcgis.com):
 *   rows = 52 (50 states + DC + Puerto Rico)
 *   sum(Total_Pop_2020) = 335085841   sum(Seats_2020) = 435
 *   max pop = California (39576757, 52 seats)   min pop = Wyoming (577719, 1 seat)
 *   states with >=20 seats = 4 (CA, TX, FL, NY)   pop > 10,000,000 = 10   pop < 1,000,000 = 7
 *
 * The deterministic offline driver replays each `script` against the in-process
 * census fixture surface and grades the synthesized answer — this is the CI
 * control and it must pass every scenario. Live LLM drivers plan their own calls
 * and are graded on the identical criteria.
 *
 * Selected via `HONUA_EVAL_CORPUS=standalone` / `--corpus standalone`; the runner
 * swaps in the census fixture client for this corpus (see `runner.ts`).
 */

const SVC = CENSUS_SERVICE_ID;
const L = 0;

export const STANDALONE_CORPUS: Scenario[] = [
  // ── Discovery (list_services) ────────────────────────────────────────────
  {
    id: "sa-discover-services",
    title: "Discover services on a plain FeatureServer folder",
    category: "discovery",
    prompt: "What feature services can I query at this endpoint? Just list them.",
    criteria: { requiredTools: ["honua_list_services"], answerMustInclude: [CENSUS_SERVICE_ID] },
    script: [{ tool: "honua_list_services", args: {} }],
  },
  {
    id: "sa-discover-details",
    title: "Discover services with details",
    category: "discovery",
    prompt: "List the services here and include their type.",
    criteria: { requiredTools: ["honua_list_services"], answerMustInclude: ["FeatureServer"] },
    script: [{ tool: "honua_list_services", args: { includeDetails: true } }],
  },

  // ── Schema / grounding (describe_layer) ──────────────────────────────────
  {
    id: "sa-describe-layer",
    title: "Inspect the layer schema before querying",
    category: "grounding",
    prompt: "Before I query, show me the fields and geometry type of layer 0 of the census service.",
    criteria: {
      requiredTools: ["honua_describe_layer"],
      answerMustInclude: ["Total_Pop_2020", "esriGeometryPolygon"],
    },
    script: [{ tool: "honua_describe_layer", args: { serviceId: SVC, layerId: L } }],
  },
  {
    id: "sa-describe-geometry",
    title: "Confirm the geometry type",
    category: "grounding",
    prompt: "Are these features points, lines, or polygons?",
    criteria: {
      requiredTools: ["honua_describe_layer"],
      answerMustInclude: ["esriGeometryPolygon"],
      answerMustNotInclude: ["esriGeometryPoint", "esriGeometryPolyline"],
    },
    script: [{ tool: "honua_describe_layer", args: { serviceId: SVC, layerId: L } }],
  },
  {
    id: "sa-describe-fields-population",
    title: "Find the population field name",
    category: "grounding",
    prompt: "Which field holds the 2020 population? Show me the schema.",
    criteria: { requiredTools: ["honua_describe_layer"], answerMustInclude: ["Total_Pop_2020"] },
    script: [{ tool: "honua_describe_layer", args: { serviceId: SVC, layerId: L } }],
  },
  {
    id: "sa-describe-fields-seats",
    title: "Find the House-seats field name",
    category: "grounding",
    prompt: "What field records the number of apportioned House seats?",
    criteria: { requiredTools: ["honua_describe_layer"], answerMustInclude: ["Seats_2020"] },
    script: [{ tool: "honua_describe_layer", args: { serviceId: SVC, layerId: L } }],
  },

  // ── Counting (count_features) — semantic counts ──────────────────────────
  {
    id: "sa-count-all",
    title: "Count all rows in the layer",
    category: "count",
    prompt: "How many features are in this layer? I only need the number, not the data.",
    criteria: {
      requiredTools: ["honua_count_features"],
      forbiddenTools: ["honua_query_features"],
      answerMustMatch: ['"count":\\s*52'],
    },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L } }],
  },
  {
    id: "sa-count-big-states",
    title: "Count states with >= 20 House seats",
    category: "count",
    prompt: "How many states have 20 or more apportioned House seats?",
    criteria: { requiredTools: ["honua_count_features"], answerMustMatch: ['"count":\\s*4'] },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L, where: "Seats_2020>=20" } }],
  },
  {
    id: "sa-count-populous",
    title: "Count rows with population over 10 million",
    category: "count",
    prompt: "How many of these areas have a 2020 population above 10 million?",
    criteria: { requiredTools: ["honua_count_features"], answerMustMatch: ['"count":\\s*10'] },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L, where: "Total_Pop_2020>10000000" } }],
  },
  {
    id: "sa-count-small",
    title: "Count rows with population under 1 million",
    category: "count",
    prompt: "How many areas have fewer than one million residents?",
    criteria: { requiredTools: ["honua_count_features"], answerMustMatch: ['"count":\\s*7'] },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L, where: "Total_Pop_2020<1000000" } }],
  },
  {
    id: "sa-count-single-seat",
    title: "Count single-seat delegations",
    category: "count",
    prompt: "How many states got exactly one House seat?",
    criteria: { requiredTools: ["honua_count_features"], answerMustMatch: ['"count":\\s*6'] },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L, where: "Seats_2020=1" } }],
  },
  {
    id: "sa-count-ge10-seats",
    title: "Count states with >= 10 seats",
    category: "count",
    prompt: "How many states have at least ten House seats?",
    criteria: { requiredTools: ["honua_count_features"], answerMustMatch: ['"count":\\s*13'] },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L, where: "Seats_2020>=10" } }],
  },
  {
    id: "sa-count-california",
    title: "Confirm California is a single row",
    category: "count",
    prompt: "Is there exactly one row for California (STUSPS = CA)?",
    criteria: { requiredTools: ["honua_count_features"], answerMustMatch: ['"count":\\s*1'] },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='CA'" } }],
  },

  // ── Statistics (statistics) — semantic aggregates ────────────────────────
  {
    id: "sa-sum-population",
    title: "Total population across all rows",
    category: "analysis",
    prompt: "What is the total 2020 population summed across every row?",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["sum_Total_Pop_2020"],
      answerMustMatch: ["335085841"],
    },
    script: [
      {
        tool: "honua_statistics",
        args: { serviceId: SVC, layerId: L, statisticType: "sum", onField: "Total_Pop_2020" },
      },
    ],
  },
  {
    id: "sa-sum-seats",
    title: "Total apportioned House seats",
    category: "analysis",
    prompt: "Add up the apportioned House seats. It should match the size of the House of Representatives.",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["sum_Seats_2020"],
      answerMustMatch: ["\\b435\\b"],
    },
    script: [
      { tool: "honua_statistics", args: { serviceId: SVC, layerId: L, statisticType: "sum", onField: "Seats_2020" } },
    ],
  },
  {
    id: "sa-max-population",
    title: "Largest single population value",
    category: "analysis",
    prompt: "What is the largest 2020 population value in the layer?",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["max_Total_Pop_2020"],
      answerMustMatch: ["39576757"],
    },
    script: [
      {
        tool: "honua_statistics",
        args: { serviceId: SVC, layerId: L, statisticType: "max", onField: "Total_Pop_2020" },
      },
    ],
  },
  {
    id: "sa-min-population",
    title: "Smallest single population value",
    category: "analysis",
    prompt: "What is the smallest 2020 population value?",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["min_Total_Pop_2020"],
      answerMustMatch: ["577719"],
    },
    script: [
      {
        tool: "honua_statistics",
        args: { serviceId: SVC, layerId: L, statisticType: "min", onField: "Total_Pop_2020" },
      },
    ],
  },
  {
    id: "sa-avg-population",
    title: "Average population per row",
    category: "analysis",
    prompt: "What is the average 2020 population across the rows?",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["avg_Total_Pop_2020"],
      answerMustMatch: ["6443958"],
    },
    script: [
      {
        tool: "honua_statistics",
        args: { serviceId: SVC, layerId: L, statisticType: "avg", onField: "Total_Pop_2020" },
      },
    ],
  },
  {
    id: "sa-avg-seats",
    title: "Average seats per row",
    category: "analysis",
    prompt: "On average, how many House seats does each row have?",
    criteria: { requiredTools: ["honua_statistics"], answerMustInclude: ["avg_Seats_2020"] },
    script: [
      { tool: "honua_statistics", args: { serviceId: SVC, layerId: L, statisticType: "avg", onField: "Seats_2020" } },
    ],
  },

  // ── Query + geographic reasoning (query_features) ────────────────────────
  {
    id: "sa-largest-state",
    title: "Which state has the most people",
    category: "reasoning",
    prompt: "Which state had the highest 2020 population? Give me the row.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["California"],
      answerMustMatch: ["39576757"],
      answerMustNotInclude: ["Wyoming", "Texas"],
    },
    script: [
      {
        tool: "honua_query_features",
        args: { serviceId: SVC, layerId: L, orderBy: "Total_Pop_2020 DESC", limit: 1 },
      },
    ],
  },
  {
    id: "sa-smallest-state",
    title: "Which state has the fewest people",
    category: "reasoning",
    prompt: "Which state had the smallest 2020 population?",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["Wyoming"],
      answerMustMatch: ["577719"],
      answerMustNotInclude: ["California"],
    },
    script: [
      {
        tool: "honua_query_features",
        args: { serviceId: SVC, layerId: L, orderBy: "Total_Pop_2020 ASC", limit: 1 },
      },
    ],
  },
  {
    id: "sa-top3-seats",
    title: "Top three states by House seats",
    category: "reasoning",
    prompt: "List the three states with the most House seats, largest first.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["California", "Texas", "Florida"],
      answerMustNotInclude: ["Wyoming"],
    },
    script: [
      {
        tool: "honua_query_features",
        args: { serviceId: SVC, layerId: L, orderBy: "Seats_2020 DESC,NAME ASC", limit: 3 },
      },
    ],
  },
  {
    id: "sa-lookup-california",
    title: "Look up California by abbreviation",
    category: "query",
    prompt: "Show me the row for California (STUSPS = CA), including population and seats.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["California"],
      answerMustMatch: ["39576757", '"Seats_2020":\\s*52'],
    },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='CA'" } }],
  },
  {
    id: "sa-lookup-texas",
    title: "Look up Texas",
    category: "query",
    prompt: "What are Texas's 2020 population and seat count?",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["Texas"],
      answerMustMatch: ["29183290", '"Seats_2020":\\s*38'],
    },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='TX'" } }],
  },
  {
    id: "sa-lookup-newyork",
    title: "Look up New York",
    category: "query",
    prompt: "Give me New York's population and number of House seats.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["New York"],
      answerMustMatch: ["20215751", '"Seats_2020":\\s*26'],
    },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='NY'" } }],
  },
  {
    id: "sa-lookup-florida",
    title: "Look up Florida",
    category: "query",
    prompt: "How many House seats did Florida get, and what was its population?",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["Florida"],
      answerMustMatch: ["21570527", '"Seats_2020":\\s*28'],
    },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='FL'" } }],
  },
  {
    id: "sa-lookup-hawaii",
    title: "Look up Hawaii",
    category: "query",
    prompt: "What is Hawaii's population and seat count?",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["Hawaii"],
      answerMustMatch: ["1460137", '"Seats_2020":\\s*2'],
    },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='HI'" } }],
  },
  {
    id: "sa-lookup-wyoming",
    title: "Look up Wyoming",
    category: "query",
    prompt: "What are Wyoming's population and seats?",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["Wyoming"],
      answerMustMatch: ["577719", '"Seats_2020":\\s*1'],
    },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='WY'" } }],
  },
  {
    id: "sa-lookup-vermont",
    title: "Look up Vermont",
    category: "query",
    prompt: "Show me Vermont's row.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["Vermont"],
      answerMustMatch: ["643503", '"Seats_2020":\\s*1'],
    },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, where: "STUSPS='VT'" } }],
  },
  {
    id: "sa-sample-features",
    title: "Fetch a small sample",
    category: "query",
    prompt: "Show me a couple of rows so I can see what the data looks like.",
    criteria: { requiredTools: ["honua_query_features"], answerMustInclude: ["features", "NAME"] },
    script: [{ tool: "honua_query_features", args: { serviceId: SVC, layerId: L, limit: 2 } }],
  },
  {
    id: "sa-big-states-list",
    title: "List the states with >= 20 seats",
    category: "query",
    prompt: "List every state with at least 20 House seats, most seats first.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["California", "Texas", "Florida", "New York"],
    },
    script: [
      {
        tool: "honua_query_features",
        args: { serviceId: SVC, layerId: L, where: "Seats_2020>=20", orderBy: "Seats_2020 DESC,NAME ASC" },
      },
    ],
  },

  // ── Extent (get_extent) ──────────────────────────────────────────────────
  {
    id: "sa-extent",
    title: "Bounding box of the layer",
    category: "query",
    prompt: "What is the spatial extent / bounding box of the layer?",
    criteria: { requiredTools: ["honua_get_extent"], answerMustInclude: ["extent"] },
    script: [{ tool: "honua_get_extent", args: { serviceId: SVC, layerId: L } }],
  },
  {
    id: "sa-extent-sr",
    title: "Extent carries a spatial reference",
    category: "query",
    prompt: "Give me the extent and tell me the spatial reference wkid it is expressed in.",
    criteria: { requiredTools: ["honua_get_extent"], answerMustMatch: ["102100|3857"] },
    script: [{ tool: "honua_get_extent", args: { serviceId: SVC, layerId: L } }],
  },

  // ── Capability degradation: styling (get_style / apply_style_preset) ─────
  {
    id: "sa-style-list-unavailable",
    title: "Styling catalog is honestly reported as unavailable",
    category: "degradation",
    prompt: "List the map styles available on this server so I can pick a basemap.",
    criteria: {
      requiredTools: ["honua_get_style"],
      answerMustInclude: ["OGC API - Styles"],
      answerMustMatch: ['"available":\\s*false'],
    },
    script: [{ tool: "honua_get_style", args: {} }],
  },
  {
    id: "sa-style-get-unavailable",
    title: "Resolving a specific style degrades gracefully",
    category: "degradation",
    prompt: "Give me the 'topographic' style definition from this endpoint.",
    criteria: {
      requiredTools: ["honua_get_style"],
      answerMustMatch: ['"available":\\s*false'],
      answerMustNotInclude: ["stylesheet applied", "mapbox-style"],
    },
    script: [{ tool: "honua_get_style", args: { styleId: "topographic" } }],
  },
  {
    id: "sa-style-preset-unavailable",
    title: "Applying a style preset degrades gracefully",
    category: "degradation",
    prompt: "Apply the 'topographic' style preset to a map for me.",
    criteria: {
      requiredTools: ["honua_apply_style_preset"],
      answerMustInclude: ["OGC API - Styles"],
      answerMustMatch: ['"available":\\s*false'],
    },
    script: [{ tool: "honua_apply_style_preset", args: { styleId: "topographic" } }],
  },
  {
    id: "sa-style-guidance",
    title: "Degradation includes a client-side workaround",
    category: "degradation",
    prompt: "I want to style this layer. What are my options on a plain FeatureServer?",
    criteria: { requiredTools: ["honua_get_style"], answerMustInclude: ["client-side"] },
    script: [{ tool: "honua_get_style", args: {} }],
  },

  // ── Capability-gap explanation (explain_capability_gap) ──────────────────
  {
    id: "sa-capability-gap-wmts",
    title: "Explain an attribute-query gap on WMTS",
    category: "grounding",
    prompt: "Can I run an attribute query against a WMTS source? If not, what should I do instead?",
    criteria: { requiredTools: ["honua_explain_capability_gap"], answerMustInclude: ["explanation"] },
    script: [{ tool: "honua_explain_capability_gap", args: { capability: "query", protocol: "wmts" } }],
  },
  {
    id: "sa-capability-gap-edit",
    title: "Explain an edit-capability question",
    category: "grounding",
    prompt: "Can I apply edits over a WMTS tile source?",
    criteria: { requiredTools: ["honua_explain_capability_gap"], answerMustInclude: ["explanation"] },
    script: [{ tool: "honua_explain_capability_gap", args: { capability: "applyEdits", protocol: "wmts" } }],
  },

  // ── Multi-step workflows ─────────────────────────────────────────────────
  {
    id: "sa-count-then-query",
    title: "Check cardinality, then sample",
    category: "multi-step",
    prompt: "How many rows are there? Then show me a couple of them.",
    criteria: {
      requiredTools: ["honua_count_features", "honua_query_features"],
      expectedToolSequence: ["honua_count_features", "honua_query_features"],
      answerMustMatch: ['"count":\\s*52'],
    },
    script: [
      { tool: "honua_count_features", args: { serviceId: SVC, layerId: L } },
      { tool: "honua_query_features", args: { serviceId: SVC, layerId: L, limit: 2 } },
    ],
  },
  {
    id: "sa-discover-describe-query",
    title: "Discover → describe → query end-to-end",
    category: "multi-step",
    prompt: "I don't know this endpoint. Find a service, inspect its first layer, then show me the most populous row.",
    criteria: {
      requiredTools: ["honua_list_services", "honua_describe_layer", "honua_query_features"],
      expectedToolSequence: ["honua_list_services", "honua_describe_layer", "honua_query_features"],
      answerMustInclude: ["California"],
    },
    script: [
      { tool: "honua_list_services", args: {} },
      { tool: "honua_describe_layer", args: { serviceId: SVC, layerId: L } },
      { tool: "honua_query_features", args: { serviceId: SVC, layerId: L, orderBy: "Total_Pop_2020 DESC", limit: 1 } },
    ],
  },
  {
    id: "sa-schema-then-stat",
    title: "Ground the field name, then aggregate",
    category: "multi-step",
    prompt: "Find the population field, then total it across all rows.",
    criteria: {
      requiredTools: ["honua_describe_layer", "honua_statistics"],
      expectedToolSequence: ["honua_describe_layer", "honua_statistics"],
      answerMustMatch: ["335085841"],
    },
    script: [
      { tool: "honua_describe_layer", args: { serviceId: SVC, layerId: L } },
      {
        tool: "honua_statistics",
        args: { serviceId: SVC, layerId: L, statisticType: "sum", onField: "Total_Pop_2020" },
      },
    ],
  },
  {
    id: "sa-count-then-list-big",
    title: "Count then enumerate the big states",
    category: "multi-step",
    prompt: "How many states have 20+ seats, and which are they?",
    criteria: {
      requiredTools: ["honua_count_features", "honua_query_features"],
      answerMustMatch: ['"count":\\s*4'],
      answerMustInclude: ["California", "New York"],
    },
    script: [
      { tool: "honua_count_features", args: { serviceId: SVC, layerId: L, where: "Seats_2020>=20" } },
      {
        tool: "honua_query_features",
        args: { serviceId: SVC, layerId: L, where: "Seats_2020>=20", orderBy: "Seats_2020 DESC,NAME ASC" },
      },
    ],
  },

  // ── Tool-selection for ambiguous asks ────────────────────────────────────
  {
    id: "sa-select-count-not-query",
    title: "Prefer count over query for a cardinality ask",
    category: "tool-selection",
    prompt: "I don't want the rows dumped — just tell me how many there are.",
    criteria: {
      requiredTools: ["honua_count_features"],
      forbiddenTools: ["honua_query_features"],
      answerMustMatch: ['"count":\\s*52'],
    },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L } }],
  },
  {
    id: "sa-select-stat-not-query",
    title: "Prefer statistics over pulling every row",
    category: "tool-selection",
    prompt: "What's the total population? Don't fetch all the rows to add them up yourself.",
    criteria: {
      requiredTools: ["honua_statistics"],
      forbiddenTools: ["honua_query_features"],
      answerMustMatch: ["335085841"],
    },
    script: [
      {
        tool: "honua_statistics",
        args: { serviceId: SVC, layerId: L, statisticType: "sum", onField: "Total_Pop_2020" },
      },
    ],
  },
  {
    id: "sa-select-extent-not-query",
    title: "Prefer extent over scanning geometries",
    category: "tool-selection",
    prompt: "What area does this layer cover? I just need the bounding box, not the shapes.",
    criteria: {
      requiredTools: ["honua_get_extent"],
      forbiddenTools: ["honua_query_features"],
      answerMustInclude: ["extent"],
    },
    script: [{ tool: "honua_get_extent", args: { serviceId: SVC, layerId: L } }],
  },
  {
    id: "sa-select-describe-not-query",
    title: "Prefer describe over query for a schema ask",
    category: "tool-selection",
    prompt: "What columns does this layer have? I don't need any actual records.",
    criteria: {
      requiredTools: ["honua_describe_layer"],
      forbiddenTools: ["honua_query_features"],
      answerMustInclude: ["Total_Pop_2020"],
    },
    script: [{ tool: "honua_describe_layer", args: { serviceId: SVC, layerId: L } }],
  },

  // ── Ambiguity / refusal / clarification ──────────────────────────────────
  {
    id: "sa-clarify-which-state",
    title: "Ambiguous 'that state' → clarify",
    category: "clarification",
    prompt: "Show me the data for that state.",
    criteria: { requiredTools: [], expectClarification: true },
    script: [],
    clarify: { question: "Which state would you like? There are 52 rows (50 states plus DC and Puerto Rico)." },
  },
  {
    id: "sa-clarify-which-field",
    title: "Ambiguous 'the number' → clarify",
    category: "clarification",
    prompt: "What's the number for California?",
    criteria: { requiredTools: [], expectClarification: true },
    script: [],
    clarify: { question: "Which value for California — the 2020 population, or the apportioned House seats?" },
  },
  {
    id: "sa-refuse-write",
    title: "Read-only endpoint → refuse an edit",
    category: "clarification",
    prompt: "Update California's population to 40 million and save it.",
    criteria: { requiredTools: [], expectClarification: true },
    script: [],
    clarify: {
      question:
        "This is a read-only public FeatureServer, so I can't edit features here. Did you want to query or analyze the data instead?",
    },
  },
  {
    id: "sa-refuse-unsupported-format",
    title: "Unsupported export → clarify",
    category: "clarification",
    prompt: "Render this as a 3D globe scene and email it to me.",
    criteria: { requiredTools: [], expectClarification: true },
    script: [],
    clarify: {
      question:
        "I can query, count, aggregate, and describe this FeatureServer, but I can't render 3D scenes or send email. What data would you like extracted?",
    },
  },
  {
    id: "sa-clarify-ambiguous-largest",
    title: "'Largest' is ambiguous (area vs population) → clarify",
    category: "clarification",
    prompt: "Which is the largest state here?",
    criteria: { requiredTools: [], expectClarification: true },
    script: [],
    clarify: {
      question:
        "Largest by which measure — 2020 population, or number of House seats? (Land area isn't in this layer.)",
    },
  },

  // ── Anti-hallucination guards ────────────────────────────────────────────
  {
    id: "sa-no-invent-most-populous",
    title: "Most-populous answer must be grounded, not guessed",
    category: "reasoning",
    prompt: "Name the single most populous state in this dataset and its exact population.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["California"],
      answerMustMatch: ["39576757"],
      answerMustNotInclude: ["Texas", "Florida", "New York"],
    },
    script: [
      { tool: "honua_query_features", args: { serviceId: SVC, layerId: L, orderBy: "Total_Pop_2020 DESC", limit: 1 } },
    ],
  },
  {
    id: "sa-no-invent-seat-total",
    title: "House-seat total must be the real 435",
    category: "analysis",
    prompt: "How many House seats are apportioned in total across the whole dataset?",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustMatch: ["\\b435\\b"],
      answerMustNotInclude: ["438", "450", "400"],
    },
    script: [
      { tool: "honua_statistics", args: { serviceId: SVC, layerId: L, statisticType: "sum", onField: "Seats_2020" } },
    ],
  },
  {
    id: "sa-no-invent-row-count",
    title: "Row count must be the real 52",
    category: "count",
    prompt: "Exactly how many rows are in this apportionment layer?",
    criteria: {
      requiredTools: ["honua_count_features"],
      answerMustMatch: ['"count":\\s*52'],
      answerMustNotInclude: ["50 rows", "51 rows"],
    },
    script: [{ tool: "honua_count_features", args: { serviceId: SVC, layerId: L } }],
  },
];
