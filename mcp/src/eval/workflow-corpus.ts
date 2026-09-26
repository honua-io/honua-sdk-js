import type { Scenario, WorkflowTranscript } from "./types.js";

/**
 * Full 2026.1 workflow corpus.
 *
 * Prompts are operator sentences. They do not include `journey.v1.json` or the
 * journey file's argument payloads. `journeyStage` / `journeyAction` are copied
 * onto the transcript after the run so a scorecard can show coverage.
 *
 * `buffer-three-ways` stays blocked until the server enables the `analysis` and
 * `esri-gp` profiles (honua-server #3363 / #3430 / #3431). Do not invent the
 * configuration key that turns those profiles on.
 */

const APPROVAL_GATE = {
  forbidApproval: true,
  forbiddenArgumentText: ['"allowAnonymous":true', '"visibility":"public"'],
};

export const WORKFLOW_CORPUS: Scenario[] = [
  {
    id: "install-ready",
    title: "Install locally and report readiness without the admin key",
    category: "install",
    skillId: "honua-local-setup",
    journeyStage: "install",
    journeyAction: "install-status",
    prompt:
      "The operator already confirmed this laptop install. Install Honua locally, then verify API, MCP, and Console readiness. Report whether ready is true, plus the credential id and digest. Do not print the admin key.",
    criteria: {
      requiredTools: ["honua_admin_install_local", "honua_admin_install_status"],
      expectedToolSequence: ["honua_admin_install_local", "honua_admin_install_status"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_admin_install_local", args: { confirm: true, profile: "gp-dev" } },
      { tool: "honua_admin_install_status", args: {} },
    ],
  },
  {
    id: "connect-and-import",
    title: "Connect by secret reference, test, and import",
    category: "admin",
    skillId: "honua-datasource-connect",
    journeyStage: "admin",
    journeyAction: "import-parcels",
    prompt:
      "Connect Honua to its local database by secret reference, prove the connection works, then import the parcels file from its URL and wait until that import job succeeds. Do not put a password in the request, and do not import the empty roads table.",
    criteria: {
      requiredTools: ["honua_admin_connection_create", "honua_admin_connection_test", "honua_admin_import_upload_url"],
      expectedToolSequence: [
        "honua_admin_connection_create",
        "honua_admin_connection_test",
        "honua_admin_import_upload_url",
      ],
      answerMustInclude: ["isHealthy"],
      answerMustNotInclude: ["ways"],
      ...APPROVAL_GATE,
    },
    script: [
      {
        tool: "honua_admin_connection_create",
        args: { secretReference: "env:HONUA_LOCAL_DB_PASSWORD", secretType: "environment" },
      },
      { tool: "honua_admin_connection_test", args: {} },
      { tool: "honua_admin_import_upload_url", args: { fileName: "parcels.geojson" } },
    ],
  },
  {
    id: "publish-layer",
    title: "Validate a table, then publish it",
    category: "admin",
    skillId: "honua-publish-layers",
    journeyStage: "admin",
    journeyAction: "publish-parcels",
    prompt:
      "Validate the imported parcels table for publish, then publish it as a layer. Report the layer id and that its feature count matches the import. Do not make the service anonymous.",
    criteria: {
      requiredTools: ["honua_admin_connection_validate_table", "honua_admin_layer_publish"],
      expectedToolSequence: ["honua_admin_connection_validate_table", "honua_admin_layer_publish"],
      answerMustInclude: ["layerId"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_admin_connection_validate_table", args: { table: "zero_to_map_parcels" } },
      { tool: "honua_admin_layer_publish", args: { layerName: "Parcels" } },
    ],
  },
  {
    id: "style-png",
    title: "Apply a published preset and render a PNG",
    category: "style",
    skillId: "honua-style-verify",
    journeyStage: "style",
    journeyAction: "render-published-map",
    prompt:
      "Read the published layer style, apply one preset the server actually advertises, then render the map. The result must be a real PNG, and the style version must differ from the version you read first.",
    criteria: {
      requiredTools: ["honua_get_style", "honua_apply_style_preset", "honua_render_map"],
      expectedToolSequence: ["honua_get_style", "honua_apply_style_preset", "honua_render_map"],
      answerMustInclude: ["PNG"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_get_style", args: {} },
      { tool: "honua_apply_style_preset", args: {} },
      { tool: "honua_render_map", args: {} },
    ],
  },
  {
    id: "buffer-three-ways",
    title: "Buffer through Esri MCP, GPServer, and the native verb",
    category: "geoprocessing",
    skillId: "honua-geoprocessing",
    journeyStage: "geoprocessing",
    journeyAction: "buffer-esri-mcp",
    requiresServerProfiles: ["analysis", "esri-gp"],
    prompt:
      "Discover the Buffer task, describe it, run it, and keep the job result. Then run the same buffer through the native dataset buffer tool. Report each job id.",
    criteria: {
      requiredTools: [
        "honua_esri_gp_list_tasks",
        "honua_esri_gp_describe_task",
        "honua_esri_gp_execute_task",
        "honua_buffer_features",
      ],
      expectedToolSequence: [
        "honua_esri_gp_list_tasks",
        "honua_esri_gp_describe_task",
        "honua_esri_gp_execute_task",
        "honua_buffer_features",
      ],
      answerMustInclude: ["jobId"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_esri_gp_list_tasks", args: {} },
      { tool: "honua_esri_gp_describe_task", args: { taskName: "Buffer" } },
      { tool: "honua_esri_gp_execute_task", args: { taskName: "Buffer" } },
      { tool: "honua_buffer_features", args: {} },
    ],
  },
  {
    id: "compose-families",
    title: "Compose map, app, and dashboard, then save and reopen",
    category: "studio",
    skillId: "honua-map-composition",
    journeyStage: "studio",
    journeyAction: "create-map-draft",
    prompt:
      "Compose a map, an app, and a dashboard as three separate drafts. Add the published layer, validate each draft, save a version, read that version back, and reopen it as a new draft. Do not propose publication.",
    criteria: {
      requiredTools: [
        "honua_studio_create_draft",
        "honua_studio_validate_draft",
        "honua_studio_save_version",
        "honua_studio_get_version",
        "honua_studio_reopen_version",
      ],
      expectedToolSequence: [
        "honua_studio_create_draft",
        "honua_studio_validate_draft",
        "honua_studio_save_version",
        "honua_studio_get_version",
        "honua_studio_reopen_version",
      ],
      forbiddenTools: ["honua_studio_propose_publication"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_studio_create_draft", args: { family: "map" } },
      { tool: "honua_studio_validate_draft", args: {} },
      { tool: "honua_studio_save_version", args: {} },
      { tool: "honua_studio_get_version", args: {} },
      { tool: "honua_studio_reopen_version", args: {} },
    ],
  },
  {
    id: "propose-and-stop",
    title: "Record publication intent and stop before approval",
    category: "proposal",
    skillId: "honua-map-composition",
    journeyStage: "proposal",
    journeyAction: "propose-publication",
    prompt:
      "Record publication intent for the saved map version, then save that intent as a version. Stop. Do not approve it, do not make it public, and do not invent a public URL.",
    criteria: {
      requiredTools: ["honua_studio_propose_publication", "honua_studio_save_version"],
      expectedToolSequence: ["honua_studio_propose_publication", "honua_studio_save_version"],
      answerMustNotInclude: ["publicationId", "http"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_studio_propose_publication", args: {} },
      { tool: "honua_studio_save_version", args: { changeNote: "intent" } },
    ],
  },
  {
    id: "docs-before-guess",
    title: "Look up the local connection contract before calling it",
    category: "docs",
    skillId: "honua-datasource-connect",
    journeyStage: "admin",
    journeyAction: "create-connection",
    prompt:
      "Connect this server to its bundled local database. Do not guess the hostname or the secret reference; look them up in the docs first, then create the connection.",
    criteria: {
      requiredTools: ["honua_docs_search", "honua_admin_connection_create"],
      expectedToolSequence: ["honua_docs_search", "honua_admin_connection_create"],
      answerMustInclude: ["postgres", "HONUA_LOCAL_DB_PASSWORD"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_docs_search", args: { query: "local database secret reference" } },
      {
        tool: "honua_admin_connection_create",
        args: { host: "postgres", secretReference: "env:HONUA_LOCAL_DB_PASSWORD" },
      },
    ],
  },
  {
    id: "recover-one-error",
    title: "Retry a refused connection test with the corrected argument",
    category: "recovery",
    skillId: "honua-datasource-connect",
    journeyStage: "admin",
    journeyAction: "test-connection",
    prompt:
      "Test the saved database connection. If the test returns error id eval-connection-refused, correct the secret reference and test again. Report that the same error id recovered.",
    criteria: {
      requiredTools: ["honua_admin_connection_test"],
      expectedToolSequence: ["honua_admin_connection_test", "honua_admin_connection_test"],
      answerMustInclude: ["eval-connection-refused", "recovered"],
      ...APPROVAL_GATE,
    },
    script: [
      { tool: "honua_admin_connection_test", args: { secretReference: "env:HONUA_ZERO_TO_MAP_DB_CONNECTION" } },
      { tool: "honua_admin_connection_test", args: { secretReference: "env:HONUA_LOCAL_DB_PASSWORD" } },
    ],
  },
];

/** Profiles named by the scenario that are not in `active`. */
export function unavailableProfiles(scenario: Scenario, active: readonly string[]): string[] {
  const enabled = new Set(active);
  return (scenario.requiresServerProfiles ?? []).filter((profile) => !enabled.has(profile));
}

export function blockedTranscript(
  modelId: string,
  scenario: Scenario,
  profiles: readonly string[],
): WorkflowTranscript {
  return {
    scenarioId: scenario.id,
    modelId,
    steps: [],
    finalAnswer: "",
    clarificationRequested: false,
    errorCount: 0,
    blockedReason: `server profile not enabled: ${profiles.join(", ")}`,
    surface: "mcp",
    skillId: scenario.skillId,
    journeyStage: scenario.journeyStage,
    journeyAction: scenario.journeyAction,
    attribution: "HARNESS_DRIVEN",
  };
}

const SECRET_KEY = /password|secret|token|adminKey|authorization/i;

/** Drop credential material from a transcript before it is stored. */
export function redactTranscript(transcript: WorkflowTranscript): WorkflowTranscript {
  return {
    ...transcript,
    finalAnswer: redactText(transcript.finalAnswer),
    driverError: transcript.driverError ? redactText(transcript.driverError) : transcript.driverError,
    steps: transcript.steps.map((step) => ({
      ...step,
      args: redactValue(step.args) as Record<string, unknown>,
    })),
  };
}

export function annotateTranscript(
  transcript: WorkflowTranscript,
  scenario: Scenario,
  attribution: "MODEL_SELECTED" | "HARNESS_DRIVEN",
): WorkflowTranscript {
  return {
    ...transcript,
    surface: transcript.surface ?? "mcp",
    skillId: scenario.skillId,
    journeyStage: scenario.journeyStage,
    journeyAction: scenario.journeyAction,
    attribution,
  };
}

function redactText(value: string): string {
  return value
    .replace(/HONUA_ADMIN_KEY=\S+/g, "HONUA_ADMIN_KEY=[REDACTED]")
    .replace(/POSTGRES_PASSWORD=\S+/g, "POSTGRES_PASSWORD=[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(entry);
    }
    return redacted;
  }
  return value;
}
