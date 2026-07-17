import "./styles.css";

import {
  DEFAULT_PROPOSAL,
  type PlanningDraft,
  type PlanningPermittingJourney,
  type PlanningReviewArtifact,
  type PlanningScenario,
  createPlanningPermittingJourney,
} from "./model.js";

declare global {
  interface Window {
    __HONUA_PLANNING_EVIDENCE__?: PlanningReviewArtifact;
  }
}

const main = required<HTMLElement>("#journey");
const searchForm = required<HTMLFormElement>("#search-form");
const addressInput = required<HTMLInputElement>("#address");
const searchStatus = required<HTMLElement>("#search-status");
const parcelResult = required<HTMLElement>("#parcel-result");
const analysisButton = required<HTMLButtonElement>("#run-analysis");
const analysisResult = required<HTMLElement>("#analysis-result");
const permitType = required<HTMLSelectElement>("#permit-type");
const heightInput = required<HTMLInputElement>("#height");
const descriptionInput = required<HTMLTextAreaElement>("#description");
const scenarioControls = required<HTMLFieldSetElement>("#scenario-controls");
const submissionStatus = required<HTMLElement>("#submission-status");
const recoverButton = required<HTMLButtonElement>("#recover");
const exportButton = required<HTMLButtonElement>("#export-review");
const reviewJson = required<HTMLElement>("#review-json");
const semanticOutput = required<HTMLOutputElement>("#journey-semantic");
const outcomes = required<HTMLOListElement>("#outcomes");

let journey: PlanningPermittingJourney | undefined;
let analyzed = false;
let busy = false;

void initialize();

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runExclusive(async () => {
    const active = requireJourney();
    searchStatus.textContent = "Geocoding and querying the planning source…";
    const receipt = await active.search(addressInput.value.trim());
    setText("#parcel-address", receipt.attributes.address);
    setText("#parcel-tmk", receipt.attributes.parcel_tmk);
    setText("#parcel-zoning", receipt.attributes.zoning);
    setText("#parcel-flood", receipt.attributes.flood_zone);
    parcelResult.hidden = false;
    analysisButton.disabled = false;
    analyzed = false;
    setEditingEnabled(false);
    searchStatus.textContent = `Matched ${receipt.geocode.address}; Source.query selected feature ${receipt.featureId}.`;
  });
});

analysisButton.addEventListener("click", () => {
  void runExclusive(async () => {
    const receipt = await requireJourney().analyze(DEFAULT_PROPOSAL);
    setText("#analysis-area", `${receipt.proposalAreaSquareMeters.toLocaleString()} m²`);
    setText("#analysis-overlap", `${receipt.hazardOverlapSquareMeters.toLocaleString()} m²`);
    setText("#analysis-candidates", `${receipt.boundedCandidateCount} / ${receipt.candidateLimit}`);
    setText("#analysis-fidelity", receipt.fidelity.status);
    const plan = required<HTMLOListElement>("#analysis-plan");
    plan.replaceChildren(
      ...receipt.plan.map((step) => {
        const item = document.createElement("li");
        const badge = document.createElement("span");
        badge.textContent = step.execution;
        item.append(badge, document.createTextNode(step.detail));
        return item;
      }),
    );
    const caveat = required<HTMLElement>("#analysis-caveat");
    caveat.textContent = receipt.fidelity.caveat;
    caveat.hidden = false;
    analysisResult.hidden = false;
    analyzed = true;
    setEditingEnabled(true);
    submissionStatus.textContent = "Analysis receipt complete. Choose a deterministic submission outcome.";
  });
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-scenario]")) {
  button.addEventListener("click", () => {
    const scenario = button.dataset.scenario as PlanningScenario;
    void runExclusive(() => runScenario(scenario));
  });
}

recoverButton.addEventListener("click", () => {
  void runExclusive(() => runScenario("success"));
});

exportButton.addEventListener("click", () => {
  const active = requireJourney();
  const artifact = active.reviewArtifact();
  window.__HONUA_PLANNING_EVIDENCE__ = artifact;
  reviewJson.textContent = JSON.stringify(artifact, null, 2);
  reviewJson.hidden = false;
  semanticOutput.value = JSON.stringify(artifact.semantic);
  semanticOutput.textContent = `Semantic contract: ${artifact.semantic.workflow} · ${artifact.semantic.publicSurfaces.join(" + ")}`;
});

window.addEventListener("pagehide", () => {
  void journey?.dispose();
});

async function initialize(): Promise<void> {
  try {
    journey = await createPlanningPermittingJourney({ baseUrl: window.location.origin });
    const inspection = journey.inspection();
    populateMetadataForm(journey.metadataFields());
    setText("#runtime-path", "createHonua().connect → Source");
    setText("#runtime-protocol", inspection.protocol);
    searchStatus.textContent = "Ready. Search the seeded Maui address to begin.";
    main.setAttribute("aria-busy", "false");
  } catch (error) {
    searchStatus.textContent = errorMessage(error);
    main.setAttribute("aria-busy", "false");
  }
}

async function runScenario(scenario: PlanningScenario): Promise<void> {
  if (!analyzed) throw new Error("Run the bounded analysis before submitting.");
  const receipt = await requireJourney().submit(draftFromForm(), scenario);
  submissionStatus.dataset.status = receipt.status;
  submissionStatus.textContent = `${scenario}: ${receipt.status}. ${receipt.recovery}`;
  recoverButton.hidden = !receipt.recoverable;
  exportButton.disabled = false;

  const item = document.createElement("li");
  item.dataset.scenario = scenario;
  item.dataset.status = receipt.status;
  const heading = document.createElement("strong");
  heading.textContent = `${scenario} · ${receipt.status}`;
  const detail = document.createElement("span");
  const failures = receipt.result.failures.map((failure) => `${failure.kind}:${failure.code ?? "n/a"}`).join(", ");
  detail.textContent = failures || "edit and attachment committed";
  const recovery = document.createElement("small");
  recovery.textContent = receipt.recovery;
  item.append(heading, detail, recovery);
  outcomes.prepend(item);
}

function draftFromForm(): PlanningDraft {
  const draft = requireJourney().createDraft(DEFAULT_PROPOSAL);
  return {
    ...draft,
    values: {
      ...draft.values,
      permit_type: permitType.value,
      proposed_height_ft: Number(heightInput.value),
      description: descriptionInput.value,
    },
  };
}

function populateMetadataForm(fields: ReturnType<PlanningPermittingJourney["metadataFields"]>): void {
  const field = fields.find((candidate) => candidate.name === "permit_type");
  const codedValues = field?.domain?.codedValues ?? [];
  permitType.replaceChildren(
    ...codedValues.map((codedValue) => {
      const option = document.createElement("option");
      option.value = String(codedValue.code);
      option.textContent = codedValue.name;
      option.selected = codedValue.code === "commercial";
      return option;
    }),
  );
}

function setEditingEnabled(enabled: boolean): void {
  permitType.disabled = !enabled;
  heightInput.disabled = !enabled;
  descriptionInput.disabled = !enabled;
  scenarioControls.disabled = !enabled;
}

async function runExclusive(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  main.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    submissionStatus.dataset.status = "failed";
    submissionStatus.textContent = errorMessage(error);
  } finally {
    busy = false;
    main.setAttribute("aria-busy", "false");
  }
}

function requireJourney(): PlanningPermittingJourney {
  if (!journey) throw new Error("The planning SDK connection is not ready yet.");
  return journey;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: unknown): void {
  required<HTMLElement>(selector).textContent = String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
