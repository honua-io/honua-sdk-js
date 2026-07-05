import type { Scenario } from "./types.js";

/**
 * NORTH-STAR corpus — the P1 gate measure (honua-server #1948, MCP initiative P1.7).
 *
 * These are the three canonical end-to-end workflows the Phase-1 gate is defined
 * against: "all 3 north-star workflows pass via a vanilla MCP client". Encoding
 * them as eval scenarios turns that gate into a mechanical pass/fail signal that
 * runs on the exact same grading (required-tool selection, ordered subsequence,
 * forbidden-tool avoidance, answer-substring evidence) as every other corpus.
 *
 * The tool names are the reference-implementation (`honua_*`) names for the
 * standard geospatial-mcp tools (see geospatial-mcp `spec/schemas/index.json`).
 * Some required tools are P1 deliverables that DO NOT yet ship on every surface:
 *
 *   - `honua_publish_result`   — standard `publish_result`, reference status
 *                                `known-gap` (promote a job/result package to a
 *                                hosted layer). Lands with P1.
 *   - `honua_apply_style_preset` — standard `apply_style_preset`, `known-gap`
 *                                (styling a published layer). Lands with P1.
 *
 * Against a server that predates the P1 tools these scenarios are EXPECTED to
 * fail — that failure is the gate signal, not a harness bug. The report makes it
 * explicit which required tools a surface is missing:
 *   - `catalog.unresolvedRequiredTools` names every required tool the live
 *     `tools/list` did not advertise, corpus-wide.
 *   - each per-scenario `results[].missingTools` names the tools THAT scenario
 *     requires but the surface lacks (the gate dashboard, per workflow).
 * The deterministic offline driver degrades HONESTLY: when its scripted ideal
 * trajectory reaches a tool the surface does not advertise it records a
 * `driverError` ("scripted tool not advertised …") and the scenario grades as
 * `error`, never a silent pass. No fixture responses are faked to make an
 * unbuilt tool look green.
 *
 * LIVE-GATED like the operator corpus: selected only via
 * `HONUA_EVAL_CORPUS=northstar` (or `--corpus northstar`), and included in
 * `all`. It is NOT part of the default analyst corpus, so the offline CI gate
 * (`test:eval`, analyst-only) is untouched. Run it live against a P1 surface
 * with `--driver bedrock` + `HONUA_MCP_REMOTE_URL=<server>/mcp` + credentials.
 */

/**
 * The generic mutation escape-hatch. Every north-star workflow must compose the
 * structured lifecycle (plan → validate → execute → publish) rather than reach
 * for `honua_propose_operation`, so forbidding it turns "did the client use the
 * intended workflow?" into a graded criterion.
 */
const GENERIC_MUTATION_TOOL = "honua_propose_operation";

/** A small, embedded address CSV for the geocode → publish workflow (10 rows). */
const ADDRESS_CSV = [
  "name,street,city,state,zip",
  "City Hall,1 Dr Carlton B Goodlett Pl,San Francisco,CA,94102",
  "Ferry Building,1 Ferry Building,San Francisco,CA,94111",
  "Coit Tower,1 Telegraph Hill Blvd,San Francisco,CA,94133",
  "Palace of Fine Arts,3601 Lyon St,San Francisco,CA,94123",
  "SFMOMA,151 3rd St,San Francisco,CA,94103",
  "Oracle Park,24 Willie Mays Plaza,San Francisco,CA,94107",
  "Golden Gate Park,501 Stanyan St,San Francisco,CA,94117",
  "Exploratorium,Pier 15 Embarcadero,San Francisco,CA,94111",
  "Chase Center,1 Warriors Way,San Francisco,CA,94158",
  "Sutro Baths,1004 Point Lobos Ave,San Francisco,CA,94121",
].join("\n");

/** Parsed address rows the geocoder batch call replays (without the header). */
const ADDRESS_ROWS = ADDRESS_CSV.split("\n")
  .slice(1)
  .map((line) => {
    const [, street, city, state, zip] = line.split(",");
    return `${street}, ${city}, ${state} ${zip}`;
  });

/** The natural-language prompt for the CSV → point-layer workflow (CSV embedded). */
const CSV_GEOCODE_PROMPT = `Here is a CSV of addresses. Geocode them and publish a point layer from the results.

\`\`\`csv
${ADDRESS_CSV}
\`\`\`

Batch-geocode every row, ingest the geocoded points as a dataset, and publish that dataset as a hosted point service. Do not reach for a raw propose_operation.`;

export const NORTHSTAR_CORPUS: Scenario[] = [
  {
    id: "northstar-styled-map",
    title: "Proximity analysis → published, styled map",
    category: "north-star",
    prompt:
      "Find all parcels within 500 m of a flood zone and produce a styled map of them. " +
      "Resolve the parcels and flood-zone layers, plan and run the proximity analysis as a " +
      "governed job, publish the result as a new layer, style it, and render a map. Use the " +
      "structured analysis lifecycle — do not reach for a raw propose_operation.",
    criteria: {
      // Load-bearing arc of the workflow: ground the entities, execute the plan,
      // publish the job artifact to a layer, and render a map of it.
      requiredTools: ["honua_resolve_entity", "honua_execute_plan", "honua_publish_result", "honua_render_map"],
      expectedToolSequence: ["honua_resolve_entity", "honua_execute_plan", "honua_publish_result", "honua_render_map"],
      forbiddenTools: [GENERIC_MUTATION_TOOL],
    },
    script: [
      { tool: "honua_resolve_entity", args: { text: "parcels", entityType: "layer" } },
      { tool: "honua_resolve_entity", args: { text: "flood zones", entityType: "layer" } },
      {
        tool: "honua_plan_analysis",
        args: { intent: "select parcels within 500 meters of a flood zone and produce a styled map" },
      },
      { tool: "honua_validate_plan", args: { plan: { planId: "northstar-styled-map-plan" } } },
      { tool: "honua_execute_plan", args: { plan: { planId: "northstar-styled-map-plan" } } },
      // P1 tools (reference known-gap today): promote the job artifact to a layer,
      // then style it. On a pre-P1 surface these are unadvertised and the driver
      // degrades to an honest driverError here rather than faking a response.
      { tool: "honua_publish_result", args: { sourceId: "northstar-styled-map-result", targetKind: "layer" } },
      {
        tool: "honua_apply_style_preset",
        args: { mapPackageId: "northstar-styled-map-package", styleId: "flood-risk" },
      },
      {
        tool: "honua_render_map",
        args: { layers: ["northstar-styled-map-layer"], bbox: [-122.55, 37.7, -122.35, 37.85] },
      },
    ],
  },
  {
    id: "northstar-csv-geocode-publish",
    title: "CSV of addresses → geocoded, published point layer",
    category: "north-star",
    prompt: CSV_GEOCODE_PROMPT,
    criteria: {
      // The CSV → point-layer arc as the standard defines it: batch geocode →
      // ingest the resulting points → publish the source table as a service.
      requiredTools: ["honua_geocode_addresses", "honua_ingest_dataset", "honua_publish_service"],
      expectedToolSequence: ["honua_geocode_addresses", "honua_ingest_dataset", "honua_publish_service"],
      forbiddenTools: [GENERIC_MUTATION_TOOL],
    },
    script: [
      { tool: "honua_geocode_addresses", args: { addresses: ADDRESS_ROWS } },
      {
        tool: "honua_ingest_dataset",
        args: {
          format: "csv",
          datasetName: "sf-landmarks",
          data: ADDRESS_CSV,
          addressColumn: "street",
        },
      },
      {
        tool: "honua_publish_service",
        args: {
          connectionId: "default",
          schema: "public",
          table: "sf_landmarks",
          layerName: "SF Landmarks",
          geometryType: "point",
        },
      },
    ],
  },
  {
    id: "northstar-buffer-stats-job",
    title: "Buffer → intersect → summary statistics, run as a job",
    category: "north-star",
    prompt:
      "Buffer highways by 100 m, intersect the buffers with wetlands, and give me summary " +
      "statistics for the overlap. Run it as a job and report progress. Ground the goal into " +
      "an analysis plan, validate it, then execute it as a governed job and report the results " +
      "the job produces. Do not reach for a raw propose_operation.",
    criteria: {
      // Plan entry → validate → execute-as-job. The answer must carry evidence
      // that the JOB path was used and its results read back — kept loose (the
      // job reference token, not exact statistic values) so live variance in the
      // numbers does not flip the grade.
      requiredTools: ["honua_plan_analysis", "honua_validate_plan", "honua_execute_plan"],
      expectedToolSequence: [
        "honua_ground_candidates",
        "honua_plan_analysis",
        "honua_validate_plan",
        "honua_execute_plan",
      ],
      forbiddenTools: [GENERIC_MUTATION_TOOL],
      answerMustInclude: ["job"],
    },
    script: [
      {
        tool: "honua_ground_candidates",
        args: {
          goal: "buffer highways by 100 meters, intersect with wetlands, and summarize the overlap",
          assumptionPolicy: "UseDefaults",
        },
      },
      {
        tool: "honua_plan_analysis",
        args: { intent: "buffer highways by 100m, intersect with wetlands, and compute summary statistics" },
      },
      { tool: "honua_validate_plan", args: { plan: { planId: "northstar-buffer-stats-plan" } } },
      // Optional dry-run estimate before committing (reference advertises it with
      // the same partial-plan input schema as validate_plan).
      { tool: "honua_dry_run_plan", args: { plan: { planId: "northstar-buffer-stats-plan" } } },
      {
        tool: "honua_execute_plan",
        args: { plan: { planId: "northstar-buffer-stats-plan" }, idempotencyKey: "northstar-buffer-stats-1" },
      },
    ],
  },
];
