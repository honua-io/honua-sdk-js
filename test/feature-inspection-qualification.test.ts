// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHonuaApplicationContext } from "../src/web-components/application-context.js";
import {
  type HonuaFeatureInspectionController,
  type HonuaFeatureInspectionElement,
  type HonuaFeatureInspectionSnapshot,
  defineHonuaFeatureInspection,
} from "../src/web-components/feature-inspection.js";

function readySnapshot(): HonuaFeatureInspectionSnapshot {
  return {
    status: "ready",
    origin: "map",
    candidates: [{ target: { sourceId: "incidents", id: 1 } }, { target: { sourceId: "incidents", id: 2 } }],
    activeIndex: 0,
    feature: {
      target: { sourceId: "incidents", id: 1 },
      title: "Harbor incident",
      description: "Open response",
      fields: [{ name: "STATUS", label: "Status", value: "open", text: "open" }],
      links: [{ label: "Report", href: "https://example.test/report", external: true }],
      attributes: { OBJECTID: 1, STATUS: "open" },
    },
    attachments: {
      items: [
        { id: 1, parentId: 1, name: "photo.jpg", size: 42, href: "https://example.test/photo" },
        { id: 2, parentId: 1 },
      ],
      offset: 0,
      limit: 2,
      total: 4,
      hasPrevious: false,
      hasNext: true,
      truncated: false,
    },
    relationships: [
      {
        id: 3,
        label: "Assigned units",
        fields: [],
        page: {
          items: [{ attributes: { OBJECTID: 11, NAME: "Engine 5" } }],
          offset: 0,
          limit: 1,
          total: 2,
          hasPrevious: false,
          hasNext: true,
          truncated: false,
        },
      },
    ],
    diagnostics: [{ code: "unsafe-link", message: "Unsafe link withheld." }],
    search: {
      status: "ready",
      query: "harbor",
      results: [
        {
          id: "incidents:1",
          target: { sourceId: "incidents", id: 1 },
          title: "Harbor incident",
          subtitle: "Incidents",
          feature: { attributes: { OBJECTID: 1, NAME: "Harbor incident" } },
        },
      ],
      diagnostics: [],
    },
  };
}

class InspectionHarness implements HonuaFeatureInspectionController {
  readonly listeners = new Set<(snapshot: HonuaFeatureInspectionSnapshot) => void>();
  state = readySnapshot();
  readonly search = vi.fn(async () => this.state.search);
  readonly navigate = vi.fn(async () => this.state);
  readonly next = vi.fn(async () => this.state);
  readonly previous = vi.fn(async () => this.state);
  readonly openSearchResult = vi.fn(async () => this.state);
  readonly setAttachmentPage = vi.fn(() => this.state);
  readonly setRelationshipPage = vi.fn(() => this.state);
  readonly refresh = vi.fn(async () => this.state);
  readonly dispose = vi.fn();
  readonly applyRealtime = vi.fn(() => this.state);
  readonly open = vi.fn(async () => this.state);
  readonly openFromMapClick = vi.fn(async () => this.state);
  readonly openFromTableRow = vi.fn(async () => this.state);

  public snapshot(): HonuaFeatureInspectionSnapshot {
    return this.state;
  }

  public subscribe(listener: (snapshot: HonuaFeatureInspectionSnapshot) => void): { remove(): void } {
    this.listeners.add(listener);
    listener(this.state);
    return { remove: () => this.listeners.delete(listener) };
  }

  public close = vi.fn(() => {
    this.emit({
      ...this.state,
      status: "idle",
      candidates: [],
      activeIndex: 0,
      feature: undefined,
      attachments: undefined,
      relationships: [],
      diagnostics: [],
    });
  });

  public emit(snapshot: HonuaFeatureInspectionSnapshot): void {
    this.state = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function mount(harness = new InspectionHarness()): {
  readonly element: HonuaFeatureInspectionElement;
  readonly harness: InspectionHarness;
} {
  defineHonuaFeatureInspection();
  const element = document.createElement("honua-feature-inspection") as HonuaFeatureInspectionElement;
  element.inspection = harness;
  document.body.append(element);
  return { element, harness };
}

function key(target: EventTarget, value: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, composed: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("<honua-feature-inspection> qualification evidence", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("externalizes every owned label and accepts application-context status messages", () => {
    const { element, harness } = mount();
    element.messages = {
      panelLabel: "Objektprüfung",
      searchLabel: "Objekte durchsuchen",
      searchButtonLabel: "Suchen",
      searchResultsLabel: "Suchergebnisse",
      closeDetailsLabel: "Details schließen",
      overlappingResultsLabel: "Überlagerte Objekte",
      previousResultLabel: "Vorheriges Objekt",
      nextResultLabel: "Nächstes Objekt",
      resultPosition: (index, total) => `${index} von ${total}`,
      refreshLabel: "Neu laden",
      featureLinksLabel: "Objektverweise",
      attachmentsLabel: "Anhänge",
      attachmentLabel: (id) => `Anhang ${String(id)}`,
      attachmentSize: (bytes) => `${bytes} Byte`,
      attachmentPagesLabel: "Anhangseiten",
      previousAttachmentsLabel: "Vorherige Anhänge",
      nextAttachmentsLabel: "Nächste Anhänge",
      relationshipPagesLabel: (label) => `Seiten für ${label}`,
      previousRelatedLabel: "Vorherige Beziehungen",
      nextRelatedLabel: "Nächste Beziehungen",
      diagnosticsLabel: "Prüfhinweise",
      diagnostic: (diagnostic) => `Hinweis: ${diagnostic.code}`,
      range: (offset, count, total) => `${offset + 1} bis ${offset + count} von ${total}`,
      showingStatus: (title) => `${title} wird angezeigt.`,
      emptyStatus: "Kein Objekt ausgewählt.",
    };

    const text = element.shadowRoot?.textContent ?? "";
    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("Objektprüfung");
    expect(text).toContain("Objekte durchsuchen");
    expect(text).toContain("Nächstes Objekt");
    expect(text).toContain("Nächste Anhänge");
    expect(text).toContain("Nächste Beziehungen");
    expect(text).toContain("Hinweis: unsafe-link");
    expect(text).not.toContain("Next attachments");
    expect(text).not.toContain("Inspection diagnostics");

    element.messages = {};
    const context = createHonuaApplicationContext({
      locale: { locale: "de-DE", direction: "ltr", status: { loading: "Wird geladen" } },
    });
    element.applicationContext = context;
    harness.emit({ ...harness.state, status: "loading" });
    expect(element.shadowRoot?.querySelector("[role='status']")?.textContent).toBe("Wird geladen");
  });

  it("emits responsive, reduced-motion, forced-colors, and direction-neutral logical styles", () => {
    const { element } = mount();
    element.setAttribute("dir", "rtl");
    const css = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(css).toContain("container-type:inline-size");
    expect(css).toContain("@container(max-width:320px)");
    expect(css).toContain("min-inline-size:0");
    expect(css).toContain("padding-inline-start");
    expect(css).toContain("text-align:start");
    expect(css).toContain("overflow-wrap:anywhere");
    expect(css).toContain("@media(prefers-reduced-motion:reduce)");
    expect(css).toContain("animation:none!important");
    expect(css).toContain("@media(forced-colors:active),(prefers-contrast:more)");
    expect(css).toContain("background:Canvas");
    expect(css).toContain("color:ButtonText");
    expect(css).not.toMatch(/(?:padding|margin|inset|text-align)-(?:left|right)|(?:left|right)\s*:/);
    expect(element.getAttribute("dir")).toBe("rtl");
  });

  it("operates every inspection action from real keydown events", () => {
    const { element, harness } = mount();
    const root = element.shadowRoot;
    if (!root) throw new Error("missing shadow root");

    key(root.querySelector("[data-action='next']") as HTMLButtonElement, "Enter");
    key(root, "ArrowRight");
    key(root, "ArrowLeft");
    key(root, "Home");
    key(root, "End");
    expect(harness.next).toHaveBeenCalledTimes(2);
    expect(harness.previous).toHaveBeenCalledTimes(1);
    expect(harness.navigate).toHaveBeenNthCalledWith(1, 0);
    expect(harness.navigate).toHaveBeenNthCalledWith(2, Number.MAX_SAFE_INTEGER);

    key(root.querySelector("[data-search-index='0']") as HTMLButtonElement, " ");
    key(root.querySelector("[data-action='attachments-next']") as HTMLButtonElement, "Enter");
    key(root.querySelector("[data-relationship-page='next']") as HTMLButtonElement, " ");
    expect(harness.openSearchResult).toHaveBeenCalledWith(0);
    expect(harness.setAttachmentPage).toHaveBeenCalledWith(1);
    expect(harness.setRelationshipPage).toHaveBeenCalledWith(3, 1);

    const search = root.querySelector<HTMLInputElement>("input[name='q']");
    if (!search) throw new Error("missing search field");
    search.value = "station";
    key(search, "Enter");
    expect(harness.search).toHaveBeenCalledWith("station");

    key(root, "/");
    expect(root.activeElement).toBe(search);

    harness.emit({ ...harness.state, status: "stale", staleReason: "stale" });
    key(root.querySelector("[data-action='refresh']") as HTMLButtonElement, "Enter");
    expect(harness.refresh).toHaveBeenCalledTimes(1);

    key(root.querySelector("[data-action='close']") as HTMLButtonElement, " ");
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("asserts dialog, combobox, listbox, option, live-region, alert, busy, and labelled paging semantics", () => {
    defineHonuaFeatureInspection();
    const element = document.createElement("honua-feature-inspection") as HonuaFeatureInspectionElement;
    element.setAttribute("presentation", "popup");
    const harness = new InspectionHarness();
    element.inspection = harness;
    document.body.append(element);
    const root = element.shadowRoot;

    expect(root?.querySelector("[role='dialog']")?.getAttribute("aria-modal")).toBe("false");
    expect(root?.querySelector("[role='dialog']")?.getAttribute("aria-labelledby")).toBe("honua-inspection-title");
    expect(root?.querySelector("[role='combobox']")?.getAttribute("aria-expanded")).toBe("true");
    expect(root?.querySelector("[role='combobox']")?.getAttribute("aria-controls")).toBe("honua-inspection-results");
    expect(root?.querySelector("[role='listbox']")?.getAttribute("aria-label")).toBe("Feature search results");
    expect(root?.querySelector("[role='option']")?.getAttribute("aria-selected")).toBe("true");
    expect(root?.querySelector("[role='status']")?.getAttribute("aria-live")).toBe("polite");
    expect(root?.querySelector("[role='alert']")?.getAttribute("aria-label")).toBe("Inspection diagnostics");
    expect(root?.querySelector("[part='panel']")?.getAttribute("aria-busy")).toBe("false");
    expect(root?.querySelector("nav")?.getAttribute("aria-label")).toBe("Overlapping feature results");

    harness.emit({ ...harness.state, status: "loading" });
    expect(root?.querySelector("[part='panel']")?.getAttribute("aria-busy")).toBe("true");
  });

  it("preserves focused input value and caret across renders, then restores the external opener on dismissal", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    const { element, harness } = mount();
    const root = element.shadowRoot;
    let search = root?.querySelector<HTMLInputElement>("input[name='q']");
    if (!root || !search) throw new Error("missing inspection search");
    search.value = "typed value";
    search.focus();
    search.setSelectionRange(2, 7, "forward");

    harness.emit({ ...harness.state, diagnostics: [] });
    search = root.querySelector<HTMLInputElement>("input[name='q']");
    expect(root.activeElement).toBe(search);
    expect(search?.value).toBe("typed value");
    expect(search?.selectionStart).toBe(2);
    expect(search?.selectionEnd).toBe(7);

    harness.emit({ ...harness.state, status: "idle", candidates: [], feature: undefined });
    opener.focus();
    harness.emit({ ...readySnapshot(), status: "loading", feature: undefined });
    harness.emit(readySnapshot());
    key(root, "Escape");
    expect(document.activeElement).toBe(opener);
  });

  it("releases subscriptions and delegated listeners, does not duplicate them, and stays console-clean", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { element, harness } = mount();
    const root = element.shadowRoot;
    if (!root) throw new Error("missing shadow root");
    expect(harness.listeners.size).toBe(1);

    for (let index = 0; index < 10; index += 1) {
      harness.emit({ ...harness.state, diagnostics: index % 2 === 0 ? [] : harness.state.diagnostics });
    }
    key(root.querySelector("[data-action='next']") as HTMLButtonElement, "Enter");
    expect(harness.next).toHaveBeenCalledTimes(1);

    element.remove();
    expect(harness.listeners.size).toBe(0);
    key(root, "ArrowRight");
    expect(harness.next).toHaveBeenCalledTimes(1);

    document.body.append(element);
    expect(harness.listeners.size).toBe(1);
    key(root, "ArrowRight");
    expect(harness.next).toHaveBeenCalledTimes(2);
    element.remove();
    expect(harness.listeners.size).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
