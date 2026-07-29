// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHonuaWebComponentController,
  defineHonuaWebComponents,
  listComponentQualifications,
} from "../src/web-components/index.js";
import type { HonuaPrintExportMessages, HonuaWebComponentController } from "../src/web-components/index.js";

/**
 * Cross-cutting lifecycle qualification gates for the `web-components` kit
 * (issue #683, REQ-005; the matrix rows these back live in
 * `src/controls/qualification.ts`).
 *
 * One harness, driven per tag, so the gates are asserted uniformly instead of
 * once for whichever element somebody happened to write a test for:
 *
 *   - `deterministic-disposal` — disconnecting releases the controller state
 *     subscription and the root `honua-controller-ready` listener, and a later
 *     controller update reaches no detached element.
 *   - `duplicate-listener` — a single interaction produces the same number of
 *     events after ten re-renders as after one. This is the assertion that
 *     catches handler accumulation, which the existing bind/unbind tests
 *     (0 -> 1 -> 0 on a collaborator) structurally cannot.
 *   - `zero-console-error` — the whole mount / drive / re-render / interact /
 *     unmount cycle emits no `console.error` and no `console.warn`.
 *   - `focus-restoration` — the shared `setShadowHtml()` capture/restore path
 *     keeps the active element across a controller-driven re-render.
 *
 * `<honua-map>` is excluded: mounting it requires a real MapLibre renderer, so
 * its teardown is covered by `test/playwright/web-components-basic.spec.mjs`
 * instead. `<honua-measurement>` is excluded because it owns a map-bound
 * lifecycle already proven by `test/web-components-measurement-element.test.ts`.
 */

/** The tags this harness drives. Kept in sync with the matrix by the last test in this file. */
const HARNESS_TAGS = [
  "honua-layer-list",
  "honua-legend",
  "honua-feature-table",
  "honua-search",
  "honua-editor",
  "honua-chart",
  "honua-basemap-control",
  "honua-bookmarks",
  "honua-locate-control",
  "honua-measure-control",
  "honua-sketch-control",
  "honua-print-export",
  "honua-map-status",
  "honua-action-panel",
] as const;

/**
 * Attributes each tag needs before it renders anything interactive. Several
 * elements are configured through attributes rather than controller state
 * (`<honua-bookmarks bookmarks>`, `<honua-action-panel actions>`), and an
 * element rendering only its "nothing is configured" empty state would make the
 * interaction-driven gates below vacuously pass.
 */
const TAG_ATTRIBUTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "honua-bookmarks": {
    bookmarks: JSON.stringify([
      { id: "downtown", label: "Downtown", viewport: { center: [-157.86, 21.31], zoom: 14 } },
      { id: "airport", label: "Airport", viewport: { center: [-157.92, 21.32], zoom: 13 } },
    ]),
  },
  "honua-action-panel": {
    actions: JSON.stringify([
      { id: "dispatch", label: "Dispatch" },
      { id: "escalate", label: "Escalate" },
    ]),
  },
  "honua-editor": { source: "incidents" },
};

/**
 * Tags whose rendered focusable control carries a stable `id`, `name`, or
 * non-empty `data-*` attribute — the only thing the base class's
 * `focusSelector()` can use to find the control again after `innerHTML` is
 * replaced.
 *
 * Determined empirically by this harness rather than assumed, and the
 * complement is asserted just as strictly: for a tag that is *not* listed the
 * test requires focus to be lost, so the day somebody fixes it this test fails
 * and forces the matrix row (`focus-restoration` in
 * `src/controls/qualification.ts`) to be updated with it. The gap is recorded,
 * not rounded off.
 */
const FOCUS_RESTORING_TAGS = new Set<string>([
  "honua-layer-list",
  "honua-feature-table",
  "honua-editor",
  "honua-basemap-control",
  "honua-bookmarks",
  "honua-measure-control",
  "honua-sketch-control",
  "honua-print-export",
  "honua-action-panel",
  // Not `honua-search`: its submit button carries no id/name/data-* so focus on
  // *that* control is lost. Its text input is the case that matters and is
  // covered by the dedicated text-field suite below, which is why the matrix
  // still records this gate as passing for the search element.
]);

/**
 * Tags that render no interactive control in any state — a legend and a chart
 * are read-only presentations. The interaction-driven gates
 * (`duplicate-listener`, focus restoration) have nothing to bind to, which the
 * matrix records as `not-applicable` rather than `passing`. Their disposal and
 * console gates still apply and are still asserted.
 */
const DISPLAY_ONLY_TAGS = new Set<string>(["honua-legend", "honua-chart"]);

interface TrackedController {
  readonly controller: HonuaWebComponentController;
  /** Live state subscriptions the controller currently holds. */
  activeSubscriptions(): number;
  /** Pushes a state change, which drives every subscribed element to re-render. */
  nudge(): void;
}

function trackedController(): TrackedController {
  const inner = createHonuaWebComponentController({
    layers: [
      // `type: "background"` / `metadata.basemap` is what makes a layer a
      // basemap candidate, and `<honua-basemap-control>` needs two of them
      // before it renders anything but its empty state.
      { id: "base-streets", title: "Streets", type: "background", visible: true, opacity: 0.8 },
      { id: "base-satellite", title: "Satellite", visible: false, metadata: { basemap: true } },
      { id: "incidents", title: "Incidents", sourceId: "incidents", visible: true },
    ],
    legend: [{ id: "incidents", label: "Incidents", color: "#cc0000", layerId: "incidents" }],
    viewport: { center: [-157.85, 21.3], zoom: 12 },
    featuresBySource: {
      incidents: [
        { id: 1, sourceId: "incidents", attributes: { name: "Alpha", status: "open" }, title: "Alpha" },
        { id: 2, sourceId: "incidents", attributes: { name: "Bravo", status: "closed" }, title: "Bravo" },
      ],
    },
    fieldsBySource: { incidents: ["name", "status"] },
    editor: {
      sourceId: "incidents",
      status: "ready",
      fields: ["name", "status"],
      capabilities: { canCreate: true, canUpdate: true, canDelete: true, readOnly: false },
    },
    // Measure and sketch controls render disabled by design without a provider,
    // so the harness supplies trivial ones to reach their real affordances.
    measurementGeometry: { startMode: () => undefined },
    sketchGeometry: { startMode: () => undefined },
    chart: {
      id: "status",
      title: "By status",
      kind: "bar",
      status: "ready",
      sourceId: "incidents",
      data: [
        { label: "open", value: 1 },
        { label: "closed", value: 1 },
      ],
    },
    searchFields: ["name"],
  });

  // `<honua-editor>` only reaches its edit path with a selected feature, and
  // selection is set through the controller rather than its factory options.
  inner.selectFeature({
    sourceId: "incidents",
    featureId: 1,
    feature: { id: 1, sourceId: "incidents", attributes: { name: "Alpha", status: "open" }, title: "Alpha" },
  });

  let live = 0;
  let zoom = 12;
  const controller: HonuaWebComponentController = {
    ...(inner as unknown as HonuaWebComponentController),
    getState: () => inner.getState(),
    subscribe: (listener) => {
      const subscription = inner.subscribe(listener);
      live += 1;
      let removed = false;
      return {
        remove: () => {
          if (removed) return;
          removed = true;
          live -= 1;
          subscription.remove();
        },
      };
    },
  };
  // Preserve prototype methods that the spread above cannot copy off a class
  // instance, binding each to the real controller.
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(inner))) {
    if (key === "constructor" || key === "getState" || key === "subscribe") continue;
    const value = (inner as unknown as Record<string, unknown>)[key];
    if (typeof value === "function") {
      (controller as unknown as Record<string, unknown>)[key] = value.bind(inner);
    }
  }

  return {
    controller,
    activeSubscriptions: () => live,
    nudge: () => {
      zoom += 0.01;
      controller.setViewport({ center: [-157.85, 21.3], zoom });
    },
  };
}

function mount(tag: string, controller: HonuaWebComponentController): HTMLElement & { controller?: unknown } {
  defineHonuaWebComponents();
  const element = document.createElement(tag) as HTMLElement & { controller?: unknown };
  for (const [name, value] of Object.entries(TAG_ATTRIBUTES[tag] ?? {})) element.setAttribute(name, value);
  document.body.append(element);
  element.controller = controller;
  return element;
}

/**
 * Lets an element's async first paint settle. `<honua-feature-table>` resolves
 * rows through `controller.queryFeatures()`, so its interactive affordances only
 * exist after a microtask turn.
 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function shadowOf(element: Element): ShadowRoot {
  const root = element.shadowRoot;
  if (!root) throw new Error(`${element.localName} rendered no shadow root`);
  return root;
}

/**
 * The control this harness drives. Buttons are preferred because clicking one is
 * unambiguously an activation; a text input or a keyboard-selectable row is
 * accepted for elements that render no button.
 */
function firstControl(element: Element): HTMLElement | undefined {
  const root = shadowOf(element);
  return (
    root.querySelector<HTMLElement>("button:not([disabled])") ??
    root.querySelector<HTMLElement>('[role="option"], tr[data-feature-id], [tabindex]:not([tabindex="-1"])') ??
    root.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled])") ??
    undefined
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // jsdom's `window.print` exists but throws "Not implemented" into its virtual
  // console. Stubbing it keeps the print path exercised (the built-in adapter
  // still declares and calls it) without jsdom noise that could be mistaken for
  // a component defect.
  vi.spyOn(window, "print").mockImplementation(() => {});
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe.each(HARNESS_TAGS)("<%s> lifecycle gates", (tag) => {
  it("releases its controller subscription when disconnected (deterministic-disposal)", () => {
    const tracked = trackedController();
    expect(tracked.activeSubscriptions()).toBe(0);

    const element = mount(tag, tracked.controller);
    element.remove();

    expect(tracked.activeSubscriptions()).toBe(0);
  });

  it("stops re-rendering after removal, so a later controller update reaches nothing (deterministic-disposal)", () => {
    const tracked = trackedController();
    const element = mount(tag, tracked.controller);
    const before = shadowOf(element).innerHTML;

    element.remove();
    tracked.nudge();

    expect(shadowOf(element).innerHTML).toBe(before);
  });

  it("stops accepting controller-ready announcements after removal (deterministic-disposal)", () => {
    const tracked = trackedController();
    const element = mount(tag, tracked.controller);
    element.remove();

    const replacement = trackedController();
    document.dispatchEvent(
      new CustomEvent("honua-controller-ready", {
        bubbles: true,
        composed: true,
        detail: { controller: replacement.controller },
      }),
    );

    expect(element.controller).toBe(tracked.controller);
    expect(replacement.activeSubscriptions()).toBe(0);
  });

  it("renders an interactive control unless it is a read-only presentation", async () => {
    const tracked = trackedController();
    const element = mount(tag, tracked.controller);
    await settle();

    if (DISPLAY_ONLY_TAGS.has(tag)) {
      // Asserted in both directions so a future interactive affordance forces
      // this tag out of the display-only set — and into the interaction gates.
      expect(firstControl(element), `${tag} is no longer display-only`).toBeUndefined();
      return;
    }
    expect(firstControl(element), `${tag} rendered no enabled control with this fixture`).toBeDefined();
  });

  it("does not accumulate handlers across re-renders (duplicate-listener)", async () => {
    if (DISPLAY_ONLY_TAGS.has(tag)) return;
    const tracked = trackedController();
    const element = mount(tag, tracked.controller);
    await settle();

    const baseline = await countEventsForOneClick(element);
    expect(baseline).toBeGreaterThan(0);
    for (let index = 0; index < 10; index += 1) tracked.nudge();
    await settle();
    const afterRerenders = await countEventsForOneClick(element);

    expect(afterRerenders).toBe(baseline);
  });

  it("emits no console error or warning across the full lifecycle (zero-console-error)", async () => {
    const tracked = trackedController();
    const element = mount(tag, tracked.controller);
    await settle();
    for (let index = 0; index < 3; index += 1) tracked.nudge();
    await settle();
    firstControl(element)?.click();
    await settle();
    element.remove();

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("preserves the active element across a controller-driven re-render (focus-restoration)", async () => {
    if (DISPLAY_ONLY_TAGS.has(tag)) return;
    const tracked = trackedController();
    const element = mount(tag, tracked.controller);
    await settle();
    const control = firstControl(element);
    if (!control) throw new Error(`${tag} rendered no enabled control`);
    control.focus();
    expect(shadowOf(element).activeElement).toBe(control);

    tracked.nudge();

    const restored = shadowOf(element).activeElement;
    if (FOCUS_RESTORING_TAGS.has(tag)) {
      expect(restored, `${tag} lost focus across a re-render`).not.toBeNull();
      expect(restored?.localName).toBe(control.localName);
    } else {
      // Recorded, not accepted: the matrix marks this tag's focus-restoration
      // gate as failing with the reason (no id/name/data-* on the control, so
      // focusSelector() cannot find it again after innerHTML is replaced).
      expect(restored).toBeNull();
    }
  });
});

/**
 * Clicks the element's first control once and returns how many events the
 * element dispatched.
 *
 * Counting `dispatchEvent` calls is deliberately generic: some elements
 * legitimately emit two events per interaction (a bookmark emits both
 * `honua-bookmark-change` and `honua-viewport-change`), and what this gate cares
 * about is that the count does not *grow* with render count. Several handlers
 * are async (export, edit, measure/sketch mode), so the count is taken after
 * the microtask queue drains.
 */
async function countEventsForOneClick(element: HTMLElement): Promise<number> {
  const control = firstControl(element);
  if (!control) return 0;
  const original = element.dispatchEvent.bind(element);
  let dispatched = 0;
  element.dispatchEvent = (event: Event) => {
    dispatched += 1;
    return original(event);
  };
  try {
    control.click();
    await settle();
  } finally {
    element.dispatchEvent = original;
  }
  return dispatched;
}

describe("text-field focus restoration", () => {
  it("keeps a focused input's value and selection range across a re-render", async () => {
    const tracked = trackedController();
    const element = mount("honua-search", tracked.controller);
    await settle();
    const input = shadowOf(element).querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("honua-search rendered no input");

    input.focus();
    input.value = "arterial";
    // A real user's keystrokes reach the element as `input` events; setting
    // `.value` alone would leave the element re-rendering from its own stale
    // query state, which is a property of this fixture rather than of the
    // capture/restore path under test.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const typed = shadowOf(element).querySelector<HTMLInputElement>("input");
    typed?.focus();
    typed?.setSelectionRange(2, 5);

    tracked.nudge();
    await settle();

    const restored = shadowOf(element).querySelector<HTMLInputElement>("input");
    expect(shadowOf(element).activeElement).toBe(restored);
    expect(restored?.value).toBe("arterial");
    expect(restored?.selectionStart).toBe(2);
    expect(restored?.selectionEnd).toBe(5);
  });
});

describe("superseded exports cannot overwrite a newer one (issue #683 review)", () => {
  /**
   * An adapter that ignores its AbortSignal and settles only when told to —
   * the realistic shape of a server-side renderer or a slow encoder. An
   * `AbortSignal` is advisory, so aborting the first export does not stop this
   * continuation from running; the element must discard it by generation.
   */
  function deferredAdapter(id: string): {
    adapter: {
      id: string;
      describeCapabilities: () => { adapterId: string; kinds: string[]; cancellable: boolean };
      exportState: () => Promise<{ mediaType: string; text: string; release: () => void }>;
    };
    settle: (text: string) => void;
    release: ReturnType<typeof vi.fn>;
  } {
    let resolve: ((value: { mediaType: string; text: string; release: () => void }) => void) | undefined;
    const release = vi.fn();
    return {
      adapter: {
        id,
        describeCapabilities: () => ({ adapterId: id, kinds: ["state"], cancellable: false }),
        exportState: () =>
          new Promise((resolveFn) => {
            resolve = resolveFn;
          }),
      },
      settle: (text: string) => resolve?.({ mediaType: "application/json", text, release }),
      release,
    };
  }

  it("discards a slow first export that completes after a newer one finished", async () => {
    const tracked = trackedController();
    const element = mount("honua-print-export", tracked.controller) as HTMLElement & {
      exportAdapter?: unknown;
      requestExport?: (kind: string) => Promise<{ status: string; text?: string }>;
      lastExportResult?: { text?: string };
    };
    const events: unknown[] = [];
    element.addEventListener("honua-export", (event) => events.push((event as CustomEvent).detail));

    const slow = deferredAdapter("slow");
    element.exportAdapter = slow.adapter;
    const first = element.requestExport?.("state");
    await settle();

    // A second export supersedes the first while it is still outstanding.
    const fast = deferredAdapter("fast");
    element.exportAdapter = fast.adapter;
    const second = element.requestExport?.("state");
    await settle();
    fast.settle('{"which":"second"}');
    await second;

    expect(element.lastExportResult?.text).toBe('{"which":"second"}');
    expect(events).toHaveLength(1);

    // Now the abort-ignoring first adapter finally settles.
    slow.settle('{"which":"first"}');
    await first;
    await settle();

    // The stale completion published nothing and dispatched nothing...
    expect(element.lastExportResult?.text).toBe('{"which":"second"}');
    expect(events).toHaveLength(1);
    // ...and its adapter resource was released rather than leaked, since
    // nothing else holds a reference to it.
    expect(slow.release).toHaveBeenCalledTimes(1);
  });

  it("resolves the superseded caller with a cancelled result carrying no bytes", async () => {
    const tracked = trackedController();
    const element = mount("honua-print-export", tracked.controller) as HTMLElement & {
      exportAdapter?: unknown;
      requestExport?: (kind: string) => Promise<{ status: string; text?: string }>;
    };
    const slow = deferredAdapter("slow");
    element.exportAdapter = slow.adapter;
    const first = element.requestExport?.("state");
    await settle();

    const fast = deferredAdapter("fast");
    element.exportAdapter = fast.adapter;
    const second = element.requestExport?.("state");
    await settle();
    fast.settle('{"which":"second"}');
    await second;

    slow.settle('{"which":"first"}');
    // Two layers agree here. The element discards the stale completion by
    // generation, and the runner independently sees its AbortSignal already
    // fired and reports `cancelled` with the payload dropped and released —
    // so even an adapter that ignores the signal cannot hand the caller bytes
    // from a superseded export.
    const superseded = await first;
    expect(superseded).toMatchObject({ status: "cancelled" });
    expect((superseded as { text?: string }).text).toBeUndefined();
    expect((superseded as { bytes?: Uint8Array }).bytes).toBeUndefined();
    expect(slow.release).toHaveBeenCalledTimes(1);
  });

  it("does not publish onto a detached element", async () => {
    const tracked = trackedController();
    const element = mount("honua-print-export", tracked.controller) as HTMLElement & {
      exportAdapter?: unknown;
      requestExport?: (kind: string) => Promise<unknown>;
      lastExportResult?: unknown;
    };
    const events: unknown[] = [];
    element.addEventListener("honua-export", (event) => events.push((event as CustomEvent).detail));

    const slow = deferredAdapter("slow");
    element.exportAdapter = slow.adapter;
    const pending = element.requestExport?.("state");
    await settle();

    element.remove();
    slow.settle('{"which":"detached"}');
    await pending;
    await settle();

    expect(element.lastExportResult).toBeUndefined();
    expect(events).toHaveLength(0);
    expect(slow.release).toHaveBeenCalledTimes(1);
  });
});

describe("print/export affordances and semantics", () => {
  it("renders German status, actions, and unsupported explanations while preserving label", () => {
    const tracked = trackedController();
    const element = mount("honua-print-export", tracked.controller) as HTMLElement & {
      messages?: HonuaPrintExportMessages;
    };
    element.setAttribute("label", "Drucken und Exportieren");
    element.messages = {
      status: { ready: "Bereit", unsupported: "Nicht verfügbar" },
      actionLabels: { print: "Drucken", snapshot: "Bild", state: "Zustand" },
      unavailable: {
        print: "Drucken erfordert einen Exportadapter.",
        snapshot: "Bild erfordert einen Exportadapter.",
        state: "Zustand erfordert einen Exportadapter.",
      },
      adapterRequired: "Exportadapter zuweisen, um Exporte zu aktivieren.",
      adapterRequiredForSnapshotState: "Exportadapter zuweisen, um Bild und Zustand zu aktivieren.",
    };

    const root = shadowOf(element);
    expect(root.querySelector("h2")?.textContent).toBe("Drucken und Exportieren");
    expect(root.querySelector(".control-panel__bar span")?.textContent).toBe("Bereit");
    expect(
      Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-export-kind]")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Drucken", "Bild", "Zustand"]);
    expect(root.querySelector('[data-export-kind="snapshot"]')?.getAttribute("title")).toBe(
      "Bild erfordert einen Exportadapter.",
    );
    expect(root.querySelector('[role="status"]')?.textContent).toBe(
      "Exportadapter zuweisen, um Bild und Zustand zu aktivieren.",
    );
  });

  it("renders snapshot and state export disabled with aria-disabled until an adapter is assigned (screen-reader-semantics)", () => {
    const tracked = trackedController();
    const element = mount("honua-print-export", tracked.controller);
    const root = shadowOf(element);

    for (const kind of ["snapshot", "state"]) {
      const button = root.querySelector<HTMLButtonElement>(`button[data-export-kind="${kind}"]`);
      expect(button, kind).not.toBeNull();
      expect(button?.getAttribute("data-export-unavailable"), kind).toBe("true");
      expect(button?.getAttribute("title") ?? "", kind).toContain("adapter");
      // Deliberately neither disabled nor aria-disabled: both suppress
      // activation, and activation is how an application learns it needs an
      // adapter. Unavailability is conveyed by the title and the live region.
      expect(button?.disabled, kind).toBe(false);
      expect(button?.hasAttribute("aria-disabled"), kind).toBe(false);
    }

    const status = root.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent ?? "").toContain("adapter");
  });

  it("still reports the unsupported outcome when an unavailable export is activated", async () => {
    const tracked = trackedController();
    const element = mount("honua-print-export", tracked.controller);
    const exports: { kind?: string; exportStatus?: string; errorCode?: string }[] = [];
    element.addEventListener("honua-export", (event) => exports.push((event as CustomEvent).detail));

    shadowOf(element).querySelector<HTMLButtonElement>('button[data-export-kind="snapshot"]')?.click();
    await settle();

    // The click is what tells an application it must supply an adapter; a
    // natively disabled button would have swallowed it silently.
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ kind: "snapshot", exportStatus: "unsupported" });
    expect(exports[0]?.errorCode).toBe("core.capability-not-supported");
  });

  it("enables snapshot and state export once an adapter is assigned, and fails closed again when it is cleared", async () => {
    const tracked = trackedController();
    const element = mount("honua-print-export", tracked.controller) as HTMLElement & {
      exportAdapter?: unknown;
      requestExport?: (kind: string) => Promise<{ status: string }>;
    };

    element.exportAdapter = {
      id: "test-adapter",
      describeCapabilities: () => ({ adapterId: "test-adapter", kinds: ["state"], cancellable: true }),
      exportState: () => ({ mediaType: "application/json", text: "{}" }),
    };

    const stateButton = shadowOf(element).querySelector<HTMLButtonElement>('button[data-export-kind="state"]');
    expect(stateButton?.hasAttribute("data-export-unavailable")).toBe(false);
    await expect(element.requestExport?.("state")).resolves.toMatchObject({ status: "ready" });

    element.exportAdapter = undefined;
    // Marked unavailable again, and the export itself fails closed again.
    expect(
      shadowOf(element)
        .querySelector<HTMLButtonElement>('button[data-export-kind="state"]')
        ?.getAttribute("data-export-unavailable"),
    ).toBe("true");
    await expect(element.requestExport?.("state")).resolves.toMatchObject({ status: "unsupported" });
  });
});

describe("responsive web-component styles", () => {
  it("emits narrow-container-safe chart rules", () => {
    const tracked = trackedController();
    const element = mount("honua-chart", tracked.controller);
    const stylesheet = shadowOf(element).querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain("@media (max-width: 320px)");
    expect(stylesheet).toContain(".bar-row { grid-template-columns: minmax(0, 1fr); }");
    expect(stylesheet).toContain(".bar { min-width: 0; width: 100%; }");
  });
});

describe("harness coverage matches the qualification matrix", () => {
  const SUITE = "test/web-components-lifecycle-gates.test.ts";

  function tagsCiting(gate: string): string[] {
    return listComponentQualifications()
      .filter((row) => row.gates.some((cell) => cell.gate === gate && cell.evidence.includes(SUITE)))
      .map((row) => row.tag)
      .sort();
  }

  it("drives exactly the tags whose matrix rows cite this suite", () => {
    // Keyed on `zero-console-error`, the one gate this harness asserts for every
    // tag it drives. A tag added here without a matrix row, or recorded in the
    // matrix without being driven here, fails this test.
    expect(tagsCiting("zero-console-error")).toEqual([...HARNESS_TAGS].sort());
    expect(tagsCiting("deterministic-disposal")).toEqual(expect.arrayContaining([...HARNESS_TAGS]));
  });

  it("claims the interaction gates only for the tags it actually interacts with", () => {
    const interactive = [...HARNESS_TAGS].filter((tag) => !DISPLAY_ONLY_TAGS.has(tag)).sort();
    expect(tagsCiting("duplicate-listener")).toEqual(interactive);
    // `honua-search` is the one focus-restoration claim this suite makes outside
    // the per-tag loop: its submit button loses focus, but its text input — the
    // case that matters — is covered by the dedicated text-field suite above.
    expect(tagsCiting("focus-restoration")).toEqual([...FOCUS_RESTORING_TAGS, "honua-search"].sort());
  });
});
