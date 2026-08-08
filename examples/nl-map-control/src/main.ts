import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import * as maplibregl from "maplibre-gl";

import type { AgentEnvelopeSigner, AgentEnvelopeVerifier } from "@honua/sdk-js/agent-safety";
import {
  type NlMapPlan,
  type NlRecordedExchange,
  approveNlMapPlan,
  createNlMapControl,
  createRecordedNlLlm,
  nlMapRuntimeBinding,
} from "@honua/sdk-js/nl-map-control";
import { sha256 } from "@honua/sdk-js/query-planner";

import recordedCompletions from "../../../test/fixtures/nl-map-control/recorded-completions.json";
import { createMapLibreAgentRuntime, incidentsGeoJson } from "./map-runtime.js";

import "./styles.css";

type ScenarioName = "viewport-filter" | "read-only-count" | "self-correction-unknown-tool";

const RECORDED = recordedCompletions as unknown as {
  readonly scenarios: Readonly<Record<string, readonly NlRecordedExchange[]>>;
};

// Demo-only envelope crypto. A real host signs approvals with its own keys
// (WebCrypto / KMS); the SDK only sees the signer/verifier callbacks.
const DEMO_SECRET = "nl-map-control-demo";
const demoSigner: AgentEnvelopeSigner = {
  algorithm: "demo-sha256",
  keyId: "demo-key-1",
  sign: async (payload) => sha256(`${DEMO_SECRET}:${payload}`),
};
const demoVerifier: AgentEnvelopeVerifier = {
  algorithm: "demo-sha256",
  keyId: "demo-key-1",
  verify: async (payload, signature) => signature === sha256(`${DEMO_SECRET}:${payload}`),
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const instructionSelect = element<HTMLSelectElement>("instruction");
const proposeButton = element<HTMLButtonElement>("propose");
const approveButton = element<HTMLButtonElement>("approve");
const rejectButton = element<HTMLButtonElement>("reject");
const statusLine = element<HTMLParagraphElement>("status");
const planPane = element<HTMLPreElement>("plan-json");
const receiptPane = element<HTMLPreElement>("receipt-json");

const DEFAULT_BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#d9e7df" },
    },
  ],
};
const BASEMAP_STYLE = import.meta.env.VITE_HONUA_NL_MAP_CONTROL_BASEMAP_STYLE ?? DEFAULT_BASEMAP_STYLE;

const effects: string[] = [];
function setStatus(text: string): void {
  statusLine.textContent = text;
}

const map = new maplibregl.Map({
  container: "map",
  attributionControl: false,
  style: BASEMAP_STYLE,
  center: [-122.3321, 47.6062],
  zoom: 10.5,
});

map.on("load", () => {
  map.addSource("incidents", { type: "geojson", data: incidentsGeoJson() });
  map.addLayer({
    id: "incidents-circles",
    type: "circle",
    source: "incidents",
    paint: {
      "circle-radius": 8,
      "circle-color": ["match", ["get", "status"], "open", "#ff5f45", "#3fb1ce"],
      "circle-stroke-color": "#eaf6ff",
      "circle-stroke-width": 1.5,
    },
  });
  setStatus("Map ready. Propose a plan — nothing executes without review.");
});

const runtime = createMapLibreAgentRuntime(map, (effect) => {
  effects.push(effect);
});

let currentPlan: NlMapPlan | undefined;

function controlFor(scenario: ScenarioName) {
  const exchanges = RECORDED.scenarios[scenario];
  if (!exchanges) throw new Error(`Missing recorded scenario "${scenario}"`);
  return createNlMapControl({
    tools: { runtime, context: { includeSafeExamples: false } },
    // Fixture LLM: replays the committed recorded completions, so the demo is
    // deterministic and needs no API key. Swap in any provider callback here.
    llm: createRecordedNlLlm(exchanges),
    policy: { actor: "demo-user@honua.io" },
    approvalVerifier: demoVerifier,
  });
}

async function executeCurrentPlan(): Promise<void> {
  const plan = currentPlan;
  if (!plan) return;
  const control = controlFor(instructionSelect.value as ScenarioName);
  effects.length = 0;
  if (plan.readOnly) {
    const execution = await control.execute(plan);
    receiptPane.textContent = JSON.stringify({ effects: [...effects], receipt: execution.receipt }, null, 2);
    setStatus(`Read-only plan auto-executed under policy — outcome: ${execution.outcome}.`);
    return;
  }
  const nowIso = new Date().toISOString();
  const approval = await approveNlMapPlan({
    plan,
    actor: "demo-user@honua.io",
    approver: "demo-operator@honua.io",
    signer: demoSigner,
    bindings: {
      map: nlMapRuntimeBinding({ observedAt: nowIso }),
      incidents: {
        id: "incidents",
        schemaVersion: "fixture-1",
        sourceVersion: "fixture-1",
        authorizationScope: ["incidents:read"],
        provenance: {
          dataMode: "replayed",
          observedAt: nowIso,
          attribution: "Honua demo fixture",
          citations: [{ uri: "https://runtime.honua.io/demo/incidents" }],
        },
      },
    },
    issuedAt: nowIso,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const execution = await control.execute(plan, { approval });
  receiptPane.textContent = JSON.stringify({ effects: [...effects], receipt: execution.receipt }, null, 2);
  setStatus(
    `Approved plan executed with a signed agent-safety envelope (digest ${approval.approval.envelopeDigest.slice(0, 23)}…) — outcome: ${execution.outcome}.`,
  );
}

proposeButton.addEventListener("click", () => {
  const scenario = instructionSelect.value as ScenarioName;
  const instruction = instructionSelect.selectedOptions[0]?.textContent?.trim() ?? "";
  const control = controlFor(scenario);
  proposeButton.disabled = true;
  setStatus("Proposing… the recorded model compiles the instruction into a typed plan.");
  control
    .propose(instruction)
    .then((plan) => {
      currentPlan = plan;
      planPane.textContent = JSON.stringify(plan, null, 2);
      receiptPane.textContent = "—";
      approveButton.disabled = false;
      rejectButton.disabled = false;
      approveButton.textContent = plan.readOnly ? "Execute (read-only, auto-approved)" : "Approve & execute";
      setStatus(
        plan.readOnly
          ? `Plan ${plan.id} is read-only (${plan.steps.length} step(s)); policy allows direct execution.`
          : `Plan ${plan.id} has effects [${plan.effects.join(", ")}] — a signed approval envelope is required.${
              plan.attempt > 1 ? ` (Self-corrected: valid on attempt ${plan.attempt}.)` : ""
            }`,
      );
    })
    .catch((error: unknown) => {
      setStatus(`Proposal failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      proposeButton.disabled = false;
    });
});

approveButton.addEventListener("click", () => {
  approveButton.disabled = true;
  rejectButton.disabled = true;
  executeCurrentPlan().catch((error: unknown) => {
    setStatus(`Execution failed: ${error instanceof Error ? error.message : String(error)}`);
  });
});

rejectButton.addEventListener("click", () => {
  currentPlan = undefined;
  planPane.textContent = "—";
  receiptPane.textContent = "—";
  approveButton.disabled = true;
  rejectButton.disabled = true;
  setStatus("Plan rejected. Nothing was executed and no receipt was emitted.");
});
