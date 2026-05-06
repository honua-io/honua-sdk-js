import { createAiSpatialAppBuilderSession, selectAiSpatialBuilderUiModels } from "./model.js";
import type { BuilderPlan, BuilderTurn } from "./types.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_AI_SPATIAL_APP_BUILDER__?: {
      ready: boolean;
      submitPrompt(text: string): BuilderTurn;
      answerClarification(choiceId: string): BuilderTurn;
      previewPlan(): BuilderPlan;
      applyAndComplete(): void;
      visibleFeatureCount: number;
    };
  }
}

const session = createAiSpatialAppBuilderSession();
let lastJobState = "Not started";

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(): void {
  renderStatus();
  renderPromptFixtures();
  renderTurn();
  renderDraft();
  renderPlan();
  renderMiniApp();
}

function renderStatus(): void {
  getElement("#fixture-state").textContent = "Fixture safe mode";
  getElement("#cache-state").textContent = session.dataset.sources.map((source) => source.cache.status).join(" / ");
  getElement("#capability-state").textContent = session.dataset.capabilityNotes
    .map((note) => `${note.title}: ${note.state}`)
    .join(" | ");
  getElement("#job-state").textContent = lastJobState;
}

function renderPromptFixtures(): void {
  getElement("#prompt-fixtures").innerHTML = session.dataset.prompts
    .map(
      (fixture) => `
        <button class="secondary" type="button" data-prompt="${escapeHtml(fixture.prompt)}">
          ${escapeHtml(fixture.id)}
        </button>
      `,
    )
    .join("");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) {
    button.addEventListener("click", () => submitPrompt(button.dataset.prompt ?? ""));
  }
}

function renderTurn(): void {
  const turn = session.lastTurn;
  getElement("#assistant-answer").textContent = turn?.assistantText ?? "Enter a natural-language spatial app request.";
  const clarification = turn?.clarification;
  const panel = getElement<HTMLElement>("#clarification");
  if (!clarification) {
    panel.innerHTML = "";
    panel.dataset.state = "empty";
    return;
  }
  panel.dataset.state = "ready";
  panel.innerHTML = `
    <h2>Clarification</h2>
    <p>${escapeHtml(clarification.question)}</p>
    <div class="button-row">
      ${clarification.choices
        .map(
          (choice) => `
            <button type="button" data-choice="${escapeHtml(choice.id)}">${escapeHtml(choice.label)}</button>
          `,
        )
        .join("")}
    </div>
  `;
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-choice]")) {
    button.addEventListener("click", () => {
      session.answerClarification(button.dataset.choice ?? "");
      render();
    });
  }
}

function renderDraft(): void {
  const draft = session.activeDraft;
  const panel = getElement<HTMLElement>("#draft-review");
  if (!draft) {
    panel.dataset.state = "empty";
    panel.innerHTML = "<h2>Draft</h2><p>No structured draft yet.</p>";
    return;
  }
  panel.dataset.state = "ready";
  panel.innerHTML = `
    <h2>Draft</h2>
    <h3>${escapeHtml(draft.title)}</h3>
    <dl>
      <dt>Predicate</dt><dd>${escapeHtml(draft.spatialPredicate)}</dd>
      <dt>Views</dt><dd>${escapeHtml(draft.views.join(", "))}</dd>
      <dt>Grouping</dt><dd>${escapeHtml(draft.grouping.join(", ") || "none")}</dd>
      <dt>Filters</dt><dd><code>${escapeHtml(JSON.stringify(draft.filters))}</code></dd>
    </dl>
    <button id="preview-plan" type="button">Preview Plan</button>
  `;
  getElement<HTMLButtonElement>("#preview-plan").addEventListener("click", () => {
    session.previewPlan();
    render();
  });
}

function renderPlan(): void {
  const plan = session.activePlan;
  const panel = getElement<HTMLElement>("#plan-preview");
  if (!plan) {
    panel.dataset.state = "empty";
    panel.innerHTML = "<h2>Plan</h2><p>No plan preview yet.</p>";
    return;
  }
  panel.dataset.state = "ready";
  panel.innerHTML = `
    <h2>Plan</h2>
    <p><strong>${escapeHtml(plan.estimatedCost)}</strong> / ${escapeHtml(plan.estimatedDuration)}</p>
    <ol>${plan.steps.map((step) => `<li data-status="${step.status}">${escapeHtml(step.title)}</li>`).join("")}</ol>
    <h3>Cache</h3>
    <ul>${plan.cacheNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
    <h3>Warnings</h3>
    <ul>${plan.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("") || "<li>None</li>"}</ul>
    <button id="apply-plan" type="button">Apply Plan</button>
    <button id="advance-job" type="button">Advance Job</button>
  `;
  getElement<HTMLButtonElement>("#apply-plan").addEventListener("click", () => {
    session.applyPlan();
    lastJobState = "Accepted";
    render();
  });
  getElement<HTMLButtonElement>("#advance-job").addEventListener("click", () => {
    const snapshot = session.advanceJob();
    lastJobState = titleCase(snapshot.status);
    render();
  });
}

function renderMiniApp(): void {
  const app = session.generatedApp();
  const rows = session.visibleFeatures();
  getElement("#generated-app-title").textContent = app?.title ?? "No generated app";
  getElement("#generated-app-state").textContent = app ? "linked" : "waiting";
  getElement("#result-count").textContent = String(rows.length);
  getElement("#result-table").innerHTML = rows.map(renderRow).join("");
  getElement("#chart-buckets").innerHTML = session
    .chartBuckets()
    .map(
      (bucket) => `
        <button class="bucket" type="button" data-zone="${escapeHtml(bucket.floodZone)}">
          <strong>${escapeHtml(bucket.floodZone)}</strong>
          <span>${bucket.count} / $${Math.round(bucket.value / 1000)}k</span>
        </button>
      `,
    )
    .join("");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-zone]")) {
    button.addEventListener("click", () => {
      session.selectChartBucket(button.dataset.zone ?? "all");
      render();
    });
  }
  const detail = selectAiSpatialBuilderUiModels(session).detail;
  getElement("#feature-detail").textContent =
    detail.selectedRecords[0]?.feature.title ?? "Select a table row to populate detail.";
  getElement("#workspace-export").textContent = session.exportState();
}

function renderRow(feature: (typeof session.dataset.features)[number]): string {
  return `
    <tr>
      <td><button type="button" data-feature="${escapeHtml(feature.id)}">Open ${escapeHtml(feature.title)}</button></td>
      <td>${escapeHtml(feature.parcelUse)}</td>
      <td>${escapeHtml(feature.floodZone)}</td>
      <td>${escapeHtml(feature.builtYear)}</td>
      <td>${escapeHtml(feature.distanceMeters)}</td>
    </tr>
  `;
}

function submitPrompt(text: string): BuilderTurn {
  const turn = session.submitPrompt(text);
  lastJobState = "Not started";
  render();
  return turn;
}

getElement<HTMLFormElement>("#builder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt(getElement<HTMLInputElement>("#builder-input").value);
});

getElement("#result-table").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const featureId = target.dataset.feature;
  if (!featureId) return;
  session.selectFeature(featureId);
  render();
});

window.__HONUA_AI_SPATIAL_APP_BUILDER__ = {
  ready: true,
  submitPrompt,
  answerClarification(choiceId: string) {
    const turn = session.answerClarification(choiceId);
    render();
    return turn;
  },
  previewPlan() {
    const plan = session.previewPlan();
    render();
    return plan;
  },
  applyAndComplete() {
    session.applyPlan();
    session.advanceJob();
    session.advanceJob();
    lastJobState = "Successful";
    render();
  },
  get visibleFeatureCount() {
    return Number(getElement("#result-count").textContent ?? "0");
  },
};

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

render();
