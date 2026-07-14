export const SAMPLE_TEST_IDS = Object.freeze({
  modeBadge: "honua-sample-mode",
  evidenceDrawer: "honua-sample-evidence",
  degradationPanel: "honua-sample-degradation",
  errorPanel: "honua-sample-error",
  disposeButton: "honua-sample-dispose",
});

declare const __HONUA_SAMPLE_SDK_MODE__: "source" | "packed";

export interface SamplePresentationOptions {
  readonly sampleId: string;
  readonly evidence: Readonly<Record<string, string>>;
  readonly onDispose?: () => void | Promise<void>;
}

export interface SamplePresentation {
  readonly root: HTMLElement;
  updateEvidence(evidence: Readonly<Record<string, string>>): void;
  showError(error: unknown): void;
  showDegradation(reasons: readonly string[]): void;
  clearStatus(): void;
}

function text(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function requireSampleElement<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required sample element: ${selector}`);
  return element;
}

export function announceSampleStatus(message: string, root: ParentNode = document): void {
  const region = root.querySelector<HTMLElement>("[data-honua-sample-announcer]");
  if (region) region.textContent = message;
}

export function mountSamplePresentation(options: SamplePresentationOptions): SamplePresentation {
  const sdkMode = typeof __HONUA_SAMPLE_SDK_MODE__ === "string" ? __HONUA_SAMPLE_SDK_MODE__ : "source";
  const root = document.createElement("aside");
  root.className = "honua-sample-kit";
  root.dataset.sampleId = options.sampleId;
  root.setAttribute("aria-label", "Demo diagnostics");

  const mode = document.createElement("span");
  mode.className = "honua-sample-kit__mode";
  mode.dataset.testid = SAMPLE_TEST_IDS.modeBadge;
  mode.dataset.sdkMode = sdkMode;
  mode.textContent = `${sdkMode} SDK`;

  const evidence = document.createElement("details");
  evidence.dataset.testid = SAMPLE_TEST_IDS.evidenceDrawer;
  const evidenceSummary = document.createElement("summary");
  evidenceSummary.textContent = "Evidence";
  const evidenceList = document.createElement("dl");
  const updateEvidence = (entries: Readonly<Record<string, string>>) => {
    evidenceList.replaceChildren();
    for (const [label, value] of Object.entries(entries)) {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      evidenceList.append(term, detail);
    }
  };
  updateEvidence(options.evidence);
  evidence.append(evidenceSummary, evidenceList);

  const degradation = document.createElement("p");
  degradation.dataset.testid = SAMPLE_TEST_IDS.degradationPanel;
  degradation.setAttribute("role", "status");
  degradation.hidden = true;

  const error = document.createElement("p");
  error.dataset.testid = SAMPLE_TEST_IDS.errorPanel;
  error.setAttribute("role", "alert");
  error.hidden = true;

  const announcer = document.createElement("span");
  announcer.className = "honua-sample-kit__sr-only";
  announcer.dataset.honuaSampleAnnouncer = "true";
  announcer.setAttribute("aria-live", "polite");

  root.append(mode, evidence, degradation, error, announcer);
  if (options.onDispose) {
    const dispose = document.createElement("button");
    dispose.type = "button";
    dispose.dataset.testid = SAMPLE_TEST_IDS.disposeButton;
    dispose.textContent = "Dispose demo";
    let disposing = false;
    dispose.addEventListener("click", async () => {
      if (disposing) return;
      disposing = true;
      dispose.disabled = true;
      try {
        await options.onDispose?.();
      } catch (value) {
        error.textContent = text(value);
        error.hidden = false;
        announceSampleStatus(`Demo cleanup error: ${error.textContent}`, root);
      }
    });
    root.append(dispose);
  }
  document.body.prepend(root);

  return {
    root,
    updateEvidence,
    showError(value) {
      error.textContent = text(value);
      error.hidden = false;
      announceSampleStatus(`Demo error: ${error.textContent}`, root);
    },
    showDegradation(reasons) {
      degradation.textContent = reasons.join(" · ");
      degradation.hidden = reasons.length === 0;
      if (reasons.length > 0) announceSampleStatus(`Demo degradation: ${degradation.textContent}`, root);
    },
    clearStatus() {
      degradation.hidden = true;
      degradation.textContent = "";
      error.hidden = true;
      error.textContent = "";
    },
  };
}
