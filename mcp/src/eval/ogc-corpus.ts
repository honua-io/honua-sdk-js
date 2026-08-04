import type { Scenario } from "./types.js";

/**
 * NON-GeoServices (OGC API Features) eval corpus — issue #1005.
 *
 * The standalone corpus proves the surface works against a plain Esri
 * FeatureServer. That is only half the vendor-neutrality claim: a tool contract
 * can pass every GeoServices scenario and still be Esri-shaped. This corpus runs
 * the same catalog against a plain **OGC API Features** endpoint — recorded from
 * the public pygeoapi demo (`src/certification/ogc-data.ts`), the pinned
 * `ogc-features` target in `config/live-conformance-endpoints.v1.json` — where
 * nothing Esri exists: no `/rest/services`, no `serviceId`, no `layerId`.
 *
 * Every scenario addresses data with the protocol-neutral
 * `ogc-features:<collectionId>` reference and filters with the typed semantic
 * filter, a `bbox`, or a canonical temporal predicate. Grading is SEMANTIC, on
 * anchors verified against the recorded data:
 *
 *   obs   (5 observations): avg(value)=96.14  max=103.5  stn_id=2147 => 2 rows
 *                           value>95 => 2     2001-01-01..2004-01-01 => 3 rows
 *                           bbox(-80,42,-78,44) => 2 rows
 *   utah_city_locations (31 cities): sum(POP_2000)=354212  max=105166 (Provo)
 *                           CO_SEAT='yes' => 1   POP_2000>100000 => 1
 *
 * Two scenarios grade HONESTY rather than data: OGC API Features has no
 * server-side aggregation and no server-side extent operation, so those answers
 * must arrive carrying an explicit degradation reason; and a CQL2 spatial
 * predicate the endpoint does not publish must come back as a structured
 * capability refusal, never as an empty feature list.
 *
 * Selected via `HONUA_EVAL_CORPUS=ogc` / `--corpus ogc`; the runner swaps in the
 * OGC fixture client for this corpus (see `runner.ts`).
 */

const OBS = "ogc-features:obs";
const CITIES = "ogc-features:utah_city_locations";

export const OGC_CORPUS: Scenario[] = [
  // ── Protocol-neutral discovery ───────────────────────────────────────────
  {
    id: "ogc-discover-sources",
    title: "Discover sources on an endpoint with no GeoServices catalog",
    category: "discovery",
    prompt: "What data can I query at this endpoint? List the sources and how I address them.",
    criteria: {
      requiredTools: ["honua_list_sources"],
      answerMustInclude: ["ogc-features:obs", "ogc-features:utah_city_locations"],
    },
    script: [{ tool: "honua_list_sources", args: {} }],
  },
  {
    id: "ogc-discover-geoservices-absent",
    title: "The GeoServices family is reported absent, not as 'no data'",
    category: "degradation",
    prompt: "Does this endpoint publish any Esri feature services? Be honest if it does not.",
    criteria: {
      requiredTools: ["honua_list_sources"],
      answerMustInclude: ["geoservices", "ogc-features:obs"],
      answerMustMatch: ['"available":\\s*false'],
    },
    script: [{ tool: "honua_list_sources", args: {} }],
  },

  // ── Schema grounding ─────────────────────────────────────────────────────
  {
    id: "ogc-describe-collection",
    title: "Inspect an OGC collection's schema before querying",
    category: "grounding",
    prompt: "Show me the fields on the observations collection before I query it.",
    criteria: {
      requiredTools: ["honua_describe_layer"],
      answerMustInclude: ["stn_id", "value", "ogc-features"],
    },
    script: [{ tool: "honua_describe_layer", args: { source: OBS } }],
  },
  {
    id: "ogc-describe-capabilities",
    title: "Report the capabilities the protocol actually advertises",
    category: "grounding",
    prompt: "What can I actually do with the observations collection — can I aggregate on the server?",
    criteria: {
      requiredTools: ["honua_describe_layer"],
      answerMustInclude: ["capabilities", "query"],
      answerMustNotInclude: ['"queryAggregate"'],
    },
    script: [{ tool: "honua_describe_layer", args: { source: OBS } }],
  },

  // ── Counting through numberMatched ───────────────────────────────────────
  {
    id: "ogc-count-all",
    title: "Count every record in an OGC collection",
    category: "count",
    prompt: "How many observations are there? Just the number.",
    criteria: {
      requiredTools: ["honua_count_features"],
      forbiddenTools: ["honua_query_features"],
      answerMustMatch: ['"count":\\s*5'],
    },
    script: [{ tool: "honua_count_features", args: { source: OBS } }],
  },
  {
    id: "ogc-count-typed-filter",
    title: "Count with the typed semantic filter (compiled to CQL2)",
    category: "count",
    prompt: "How many observations came from station 2147?",
    criteria: {
      requiredTools: ["honua_count_features"],
      answerMustMatch: ['"count":\\s*2'],
    },
    script: [
      {
        tool: "honua_count_features",
        args: { source: OBS, filter: { op: "eq", field: "stn_id", value: 2147 } },
      },
    ],
  },
  {
    id: "ogc-count-county-seat",
    title: "Count with a string equality filter",
    category: "count",
    prompt: "How many of these Utah cities are county seats?",
    criteria: {
      requiredTools: ["honua_count_features"],
      answerMustMatch: ['"count":\\s*1'],
    },
    script: [
      {
        tool: "honua_count_features",
        args: { source: CITIES, filter: { op: "eq", field: "CO_SEAT", value: "yes" } },
      },
    ],
  },

  // ── Typed filter + ordering ──────────────────────────────────────────────
  {
    id: "ogc-filter-and-sort",
    title: "Filter and sort with the protocol-neutral vocabulary",
    category: "query",
    prompt: "Show me the observations with a value above 95, highest first.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustMatch: ["103.5", '"returnedCount":\\s*2'],
    },
    script: [
      {
        tool: "honua_query_features",
        args: {
          source: OBS,
          filter: { op: "gt", field: "value", value: 95 },
          orderBy: [{ field: "value", direction: "desc" }],
        },
      },
    ],
  },
  {
    id: "ogc-filter-compound",
    title: "Compound AND filter over an OGC collection",
    category: "query",
    prompt: "Which observations from station 2147 have a value under 100?",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustMatch: ["93.5", '"returnedCount":\\s*1'],
      answerMustNotInclude: ["103.5"],
    },
    script: [
      {
        tool: "honua_query_features",
        args: {
          source: OBS,
          filter: {
            op: "and",
            args: [
              { op: "eq", field: "stn_id", value: 2147 },
              { op: "lt", field: "value", value: 100 },
            ],
          },
        },
      },
    ],
  },
  {
    id: "ogc-filter-largest-city",
    title: "Find the largest city with a typed filter",
    category: "reasoning",
    prompt: "Which of these Utah cities had more than 100,000 people in 2000?",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustMatch: ["105166", '"returnedCount":\\s*1'],
    },
    script: [
      {
        tool: "honua_query_features",
        args: { source: CITIES, filter: { op: "gt", field: "POP_2000", value: 100000 } },
      },
    ],
  },

  // ── Canonical geometry + temporal predicates ─────────────────────────────
  {
    id: "ogc-bbox-filter",
    title: "Spatial filter through the canonical bbox",
    category: "query",
    prompt: "Which observations fall inside the box from -80,42 to -78,44? Include their geometry.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustMatch: ['"returnedCount":\\s*2', '"geometryFormat":\\s*"geojson"'],
      answerMustInclude: ["Point"],
    },
    script: [
      {
        tool: "honua_query_features",
        args: { source: OBS, bbox: [-80, 42, -78, 44], returnGeometry: true },
      },
    ],
  },
  {
    id: "ogc-temporal-interval",
    title: "Canonical temporal interval on the collection time dimension",
    category: "query",
    prompt: "How many observations were recorded between 2001 and the start of 2004?",
    criteria: {
      requiredTools: ["honua_count_features"],
      answerMustMatch: ['"count":\\s*3'],
    },
    script: [
      {
        tool: "honua_count_features",
        args: { source: OBS, temporal: { start: "2001-01-01T00:00:00Z", end: "2004-01-01T00:00:00Z" } },
      },
    ],
  },
  {
    id: "ogc-temporal-field",
    title: "Canonical temporal predicate bound to an explicit field",
    category: "query",
    prompt: "Count the observations whose datetime column falls in 2001 through 2003.",
    criteria: {
      requiredTools: ["honua_count_features"],
      answerMustMatch: ['"count":\\s*3'],
    },
    script: [
      {
        tool: "honua_count_features",
        args: {
          source: OBS,
          temporal: { start: "2001-01-01T00:00:00Z", end: "2004-01-01T00:00:00Z", field: "datetime" },
        },
      },
    ],
  },

  // ── Aggregation with honest degradation ──────────────────────────────────
  {
    id: "ogc-aggregate-sum",
    title: "Aggregate over a protocol with no server-side aggregation",
    category: "analysis",
    prompt: "What is the total 2000 population across these Utah cities?",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["sum_POP_2000"],
      answerMustMatch: ["354212"],
    },
    script: [{ tool: "honua_statistics", args: { source: CITIES, statisticType: "sum", onField: "POP_2000" } }],
  },
  {
    id: "ogc-aggregate-degradation-reported",
    title: "Client-side aggregation is reported, not passed off as server-side",
    category: "degradation",
    prompt: "Average the observation values, and tell me whether the server computed that or you did.",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["degraded", "queryAggregate", "client-side"],
      answerMustMatch: ["96.14"],
    },
    script: [{ tool: "honua_statistics", args: { source: OBS, statisticType: "avg", onField: "value" } }],
  },
  {
    id: "ogc-aggregate-grouped",
    title: "Grouped aggregation across an OGC collection",
    category: "analysis",
    prompt: "Break the Utah cities down by whether they are county seats and count each group.",
    criteria: {
      requiredTools: ["honua_statistics"],
      answerMustInclude: ["CO_SEAT"],
      answerMustMatch: ['"count_POP_2000":\\s*30', '"count_POP_2000":\\s*1'],
    },
    script: [
      {
        tool: "honua_statistics",
        args: { source: CITIES, statisticType: "count", onField: "POP_2000", groupBy: ["CO_SEAT"] },
      },
    ],
  },

  // ── Extent with honest provenance ────────────────────────────────────────
  {
    id: "ogc-extent-declared",
    title: "Extent comes from the declared collection extent, and says so",
    category: "degradation",
    prompt: "What area do these Utah cities cover?",
    criteria: {
      requiredTools: ["honua_get_extent"],
      answerMustInclude: ["declared-extent"],
      answerMustMatch: ["-112.108489"],
    },
    script: [{ tool: "honua_get_extent", args: { source: CITIES } }],
  },

  // ── Capability honesty ───────────────────────────────────────────────────
  {
    id: "ogc-spatial-predicate-refused",
    title: "An inexpressible spatial predicate refuses instead of returning nothing",
    category: "degradation",
    prompt:
      "Find the observations strictly within this polygon. If this endpoint cannot do that, say so — do not tell me there are none.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["Part 3"],
      answerMustNotInclude: ['"returnedCount": 0'],
    },
    script: [
      {
        tool: "honua_query_features",
        args: {
          source: OBS,
          filter: {
            op: "within",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-80, 42],
                  [-78, 42],
                  [-78, 44],
                  [-80, 44],
                  [-80, 42],
                ],
              ],
            },
          },
        },
      },
    ],
  },
  {
    id: "ogc-bad-source-reference",
    title: "A malformed source reference is refused with the accepted forms",
    category: "grounding",
    prompt: "Query the collection called 'observations-2024' on this server.",
    criteria: {
      requiredTools: ["honua_query_features"],
      answerMustInclude: ["invalid_source_reference", "ogc-features:<collectionId>"],
    },
    script: [{ tool: "honua_query_features", args: { source: "observations-2024" } }],
  },
  {
    id: "ogc-style-unavailable",
    title: "Styling degrades honestly on an OGC endpoint too",
    category: "degradation",
    prompt: "List the map styles this endpoint publishes.",
    criteria: {
      requiredTools: ["honua_get_style"],
      answerMustInclude: ["OGC API - Styles"],
      answerMustMatch: ['"available":\\s*false'],
    },
    script: [{ tool: "honua_get_style", args: {} }],
  },
  {
    id: "ogc-capability-gap-explained",
    title: "Explain the aggregation gap for the OGC protocol",
    category: "grounding",
    prompt: "Can OGC API Features aggregate on the server? If not, what should I do instead?",
    criteria: {
      requiredTools: ["honua_explain_capability_gap"],
      answerMustInclude: ["explanation"],
    },
    script: [
      {
        tool: "honua_explain_capability_gap",
        args: { capability: "queryAggregate", protocol: "ogc-features" },
      },
    ],
  },

  // ── Multi-step workflows ─────────────────────────────────────────────────
  {
    id: "ogc-discover-describe-query",
    title: "Discover → describe → query, end to end, with zero Esri vocabulary",
    category: "multi-step",
    prompt:
      "I don't know this endpoint. Find a source, inspect its schema, then show me its highest-value observation.",
    criteria: {
      requiredTools: ["honua_list_sources", "honua_describe_layer", "honua_query_features"],
      expectedToolSequence: ["honua_list_sources", "honua_describe_layer", "honua_query_features"],
      answerMustMatch: ["103.5"],
    },
    script: [
      { tool: "honua_list_sources", args: {} },
      { tool: "honua_describe_layer", args: { source: OBS } },
      {
        tool: "honua_query_features",
        args: { source: OBS, orderBy: [{ field: "value", direction: "desc" }], limit: 1 },
      },
    ],
  },
  {
    id: "ogc-count-then-list",
    title: "Check cardinality, then fetch the matching records",
    category: "multi-step",
    prompt: "How many observations exceed 95, and which are they?",
    criteria: {
      requiredTools: ["honua_count_features", "honua_query_features"],
      expectedToolSequence: ["honua_count_features", "honua_query_features"],
      answerMustMatch: ['"count":\\s*2', "99.9"],
    },
    script: [
      {
        tool: "honua_count_features",
        args: { source: OBS, filter: { op: "gt", field: "value", value: 95 } },
      },
      {
        tool: "honua_query_features",
        args: { source: OBS, filter: { op: "gt", field: "value", value: 95 } },
      },
    ],
  },

  // ── Ambiguity / refusal ──────────────────────────────────────────────────
  {
    id: "ogc-clarify-which-collection",
    title: "Ambiguous 'the data' → clarify which collection",
    category: "clarification",
    prompt: "Show me the data from this server.",
    criteria: { requiredTools: [], expectClarification: true },
    script: [],
    clarify: {
      question:
        "Which collection would you like — the observations (ogc-features:obs) or the Utah city locations (ogc-features:utah_city_locations)?",
    },
  },
  {
    id: "ogc-refuse-write",
    title: "Read-only endpoint → refuse an edit",
    category: "clarification",
    prompt: "Set every observation value to 100 and save it.",
    criteria: { requiredTools: [], expectClarification: true },
    script: [],
    clarify: {
      question:
        "This MCP surface is read-only, so I can't write features to this OGC API Features endpoint. Would you like me to query or aggregate the observations instead?",
    },
  },
];
