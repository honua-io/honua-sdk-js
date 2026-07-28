/**
 * The **production qualification matrix** for the Honua custom-element kit
 * (issue #683, parent epic #678; REQ-004 / REQ-005 / NFR-001).
 *
 * Epic #678's premise is that "production support" for a component library is
 * not a claim anybody gets to make in prose. It is a matrix: every shipped
 * component × every gate that matters, each cell carrying a status and, when
 * the status is a claim of success, the automated evidence that backs it. This
 * module is that matrix, and it extends the existing component catalog
 * ({@link "./catalog.js"}) rather than introducing a second inventory —
 * `HONUA_COMPONENT_CATALOG` remains the single list of shipped tags, and every
 * catalog id must appear here exactly once (enforced by
 * `scripts/component-qualification.mjs`).
 *
 * ## The honesty rules
 *
 * The matrix is seeded from what the test suite *actually* asserts today, not
 * from what the components ought to do. Concretely:
 *
 * - `"passing"` requires at least one existing test file as evidence, and the
 *   CI verifier fails if any referenced file is missing. Deleting the test that
 *   backs a gate therefore breaks the build rather than quietly downgrading the
 *   claim.
 * - `"failing"` is used where the requirement is *known* not to be met —
 *   including from code inspection, before an automated gate exists. It always
 *   carries a note naming the mechanism. This is deliberately more informative
 *   than `"pending"`: "we know the components hard-code English strings" is a
 *   different engineering state from "nobody has looked".
 * - `"pending"` means no automated gate and no established verdict. It is the
 *   default, and most of this matrix is honestly in it.
 * - `"not-applicable"` requires a note justifying why the gate cannot apply to
 *   that component — it is the only status that can silently remove work, so it
 *   is the one that most needs an argument attached.
 *
 * Nothing here is aspirational, and this matrix is a *different axis* from the
 * catalog's `supportTier`. The tier records the functional maturity whichever
 * feature issue (#680-#683) delivered on a component; this records the
 * cross-cutting gates, which no component has cleared yet. The verifier enforces
 * only the direction that is implied — clearing every gate requires the
 * production tier, since gate completion is the harder bar — and surfaces every
 * production-tier component's still-open gates rather than pretending the tier
 * settles them. See {@link isComponentProductionQualified} and
 * {@link listOpenQualificationGates}.
 *
 * ## Shape
 *
 * The declarations below are stored **inverted** — per gate, the groups of
 * components that share a status and evidence — because that is how the
 * evidence actually clusters (one test file typically proves one gate for
 * several components) and because it keeps the reviewable diff small. The
 * public API ({@link getComponentQualification},
 * {@link listComponentQualifications}) expands it back into the dense
 * per-component × per-gate matrix that consumers and the generated
 * `config/component-qualification.v1.json` manifest want.
 *
 * Like `./catalog.js` this module is pure metadata: no DOM, no element classes,
 * no registration, no `src/core` or `src/runtime` import. Importing it costs a
 * consumer bundle nothing that NFR-001 forbids.
 *
 * @module
 */

import { HONUA_COMPONENT_CATALOG, type HonuaComponentCatalogEntry } from "./catalog.js";

/**
 * Bumped whenever a gate is added/removed or a status vocabulary changes, so
 * the generated manifest and any external consumer can detect a shape change
 * distinctly from a routine status update.
 */
export const HONUA_COMPONENT_QUALIFICATION_DATA_VERSION = "1.0.0";

/** Which issue requirement a gate discharges. */
export type HonuaComponentQualificationRequirement = "REQ-004" | "REQ-005" | "NFR-001";

/** Closed status vocabulary. See the module doc for the honesty rules. */
export type HonuaComponentQualificationStatus = "passing" | "failing" | "pending" | "not-applicable";

/** Every status, in escalating-confidence order. */
export const HONUA_COMPONENT_QUALIFICATION_STATUSES: readonly HonuaComponentQualificationStatus[] = Object.freeze([
  "passing",
  "failing",
  "pending",
  "not-applicable",
] as const);

/** Stable gate ids. Never reused; adding one bumps the data version. */
export type HonuaComponentQualificationGateId =
  // REQ-004 — accessibility, localization, and visual behavior
  | "keyboard-behavior"
  | "screen-reader-semantics"
  | "focus-restoration"
  | "reduced-motion"
  | "high-contrast"
  | "responsive-layout"
  | "localization"
  | "pseudo-locale"
  | "rtl"
  // REQ-005 — engineering gates
  | "visual-regression"
  | "strict-csp"
  | "zero-console-error"
  | "deterministic-disposal"
  | "duplicate-listener"
  | "memory-leak"
  | "ssr-import"
  | "bundle-budget";

/** One gate's definition: what it means and what would satisfy it. */
export interface HonuaComponentQualificationGate {
  readonly id: HonuaComponentQualificationGateId;
  readonly requirement: HonuaComponentQualificationRequirement;
  readonly title: string;
  /** What a `passing` cell asserts for this gate. */
  readonly criterion: string;
}

/** The full gate list, in a stable order. */
export const HONUA_COMPONENT_QUALIFICATION_GATES: readonly HonuaComponentQualificationGate[] = Object.freeze([
  {
    id: "keyboard-behavior",
    requirement: "REQ-004",
    title: "Keyboard behavior",
    criterion:
      "Every interactive affordance is operable from the keyboard alone, proven by dispatching real key events (not synthetic clicks) and asserting the resulting state change.",
  },
  {
    id: "screen-reader-semantics",
    requirement: "REQ-004",
    title: "Screen-reader semantics",
    criterion:
      "Roles, accessible names, state (pressed/checked/expanded/selected), and live regions are asserted on the rendered shadow tree.",
  },
  {
    id: "focus-restoration",
    requirement: "REQ-004",
    title: "Focus restoration",
    criterion:
      "A state-driven re-render preserves the active element and, for text fields, the caret/selection range — asserted, not assumed from the shared setShadowHtml() helper.",
  },
  {
    id: "reduced-motion",
    requirement: "REQ-004",
    title: "Reduced motion",
    criterion:
      "Any animation the component owns, whether CSS or a programmatic camera move, is suppressed or shortened under prefers-reduced-motion.",
  },
  {
    id: "high-contrast",
    requirement: "REQ-004",
    title: "High contrast / forced colors",
    criterion:
      "The component remains legible and its state remains distinguishable under forced-colors: active and prefers-contrast: more.",
  },
  {
    id: "responsive-layout",
    requirement: "REQ-004",
    title: "Responsive layout",
    criterion:
      "The component adapts to its container across the supported width range without clipping content or forcing horizontal overflow.",
  },
  {
    id: "localization",
    requirement: "REQ-004",
    title: "Localization",
    criterion:
      "Every user-visible string is externalized and resolvable through an injectable message source; no user-visible literal is hard-coded in the render template.",
  },
  {
    id: "pseudo-locale",
    requirement: "REQ-004",
    title: "Pseudo-locale expansion",
    criterion:
      "Rendering under an accented/expanded pseudo-locale neither truncates nor overflows any label, proving the layout tolerates real translation growth.",
  },
  {
    id: "rtl",
    requirement: "REQ-004",
    title: "Right-to-left",
    criterion:
      "Under dir=rtl the component mirrors correctly, using logical properties rather than physical left/right offsets.",
  },
  {
    id: "visual-regression",
    requirement: "REQ-005",
    title: "Visual regression",
    criterion: "A committed reference screenshot is compared per release, so unintended visual change fails CI.",
  },
  {
    id: "strict-csp",
    requirement: "REQ-005",
    title: "Strict CSP",
    criterion:
      "The component renders and functions under a strict Content-Security-Policy with no 'unsafe-inline' for script or style, producing no CSP violation reports.",
  },
  {
    id: "zero-console-error",
    requirement: "REQ-005",
    title: "Zero console error",
    criterion:
      "Mounting, driving, and unmounting the component emits no console.error or console.warn and raises no uncaught exception.",
  },
  {
    id: "deterministic-disposal",
    requirement: "REQ-005",
    title: "Deterministic disposal",
    criterion:
      "Disconnecting the element releases every subscription, listener, timer, and in-flight request it created, asserted by observing the collaborator's listener count drop to zero.",
  },
  {
    id: "duplicate-listener",
    requirement: "REQ-005",
    title: "No duplicate listeners",
    criterion:
      "Repeated re-renders do not accumulate handlers: a single user interaction after N renders still produces exactly one event.",
  },
  {
    id: "memory-leak",
    requirement: "REQ-005",
    title: "Memory retention",
    criterion:
      "A mounted-then-removed element is not retained, proven by a WeakRef/heap-retention probe after the controller is released.",
  },
  {
    id: "ssr-import",
    requirement: "REQ-005",
    title: "SSR-safe import",
    criterion:
      "The owning entrypoint imports cleanly with no DOM globals present, defining no custom element and touching no browser API at module scope.",
  },
  {
    id: "bundle-budget",
    requirement: "NFR-001",
    title: "Per-entrypoint bundle budget",
    criterion:
      "The owning kit's entrypoint carries a declared byte ceiling in bundle-budgets.json, enforced by npm run verify:bundle-budgets, and is forbidden from statically retaining a renderer, PDF writer, image encoder, localization framework, or test-only peer.",
  },
] as const);

/** One cell of the matrix. */
export interface HonuaComponentQualificationCell {
  readonly gate: HonuaComponentQualificationGateId;
  readonly requirement: HonuaComponentQualificationRequirement;
  readonly status: HonuaComponentQualificationStatus;
  /** Repo-relative files that prove a `passing` status. Empty otherwise. */
  readonly evidence: readonly string[];
  /** Required for `failing` and `not-applicable`; optional context otherwise. */
  readonly note?: string;
}

/** One component's full row. */
export interface HonuaComponentQualification {
  readonly id: string;
  readonly tag: string;
  readonly source: HonuaComponentCatalogEntry["source"];
  readonly gates: readonly HonuaComponentQualificationCell[];
}

/** Aggregate counts for a row or for the whole matrix. */
export interface HonuaComponentQualificationSummary {
  readonly passing: number;
  readonly failing: number;
  readonly pending: number;
  readonly notApplicable: number;
  /** Gates that must still reach `passing` before production tier. */
  readonly blocking: readonly HonuaComponentQualificationGateId[];
}

// ── declarations ─────────────────────────────────────────────────────────

/** Catalog id groups referenced repeatedly below. */
const ALL_IDS = HONUA_COMPONENT_CATALOG.map((entry) => entry.id);

/** Every catalog id except the named ones, for gates where one component differs. */
function allExcept(...excluded: readonly string[]): readonly string[] {
  return ALL_IDS.filter((id) => !excluded.includes(id));
}

/**
 * `<honua-feature-editor>` (issue #680) is the kit's first component the catalog
 * declares `production-tier`, and it is the reason the tier cross-check below is
 * one-directional. Its own suites are the strongest in the kit on the gates they
 * cover: real keyboard events, a thorough ARIA contract, text-input focus
 * restoration across a reconciling re-render, and — since issue #809 — the kit's
 * only invocation-counting proofs of single-binding and full listener release.
 *
 * It is also the matrix earning its keep. Seeding it honestly recorded two
 * `failing` cells naming a per-render shadow-root listener that accumulated and
 * was never released on disconnect; #809 fixed exactly those two defects and
 * added regression tests that count invocations rather than assert state, and
 * both cells now flip to `passing` on that evidence. A matrix that had rounded
 * those up to "probably fine" would have had nothing to flip.
 */
const FEATURE_EDITOR = "web-components.feature-editor";
const FEATURE_EDITOR_SUITE = "test/web-components-feature-editor-element.test.ts";

/**
 * `<honua-feature-table>`'s bounded production lane (issue #681) brought the
 * kit's most complete ARIA-grid contract and its only two-lane keyboard suite,
 * so several of its rows are re-seeded from that evidence rather than from the
 * cross-cutting harness alone.
 */
const FEATURE_TABLE = "web-components.feature-table";
const FEATURE_TABLE_SUITE = "test/web-components-feature-table-element.test.ts";

/**
 * The web-components tags covered by the cross-cutting lifecycle harness
 * `test/web-components-lifecycle-gates.test.ts`. `web-components.map` is
 * excluded because mounting it requires a real MapLibre renderer (its disposal
 * is covered by the browser spec instead), and `web-components.measurement`
 * because it owns a map-bound lifecycle proven by its own suite.
 */
const LIFECYCLE_HARNESS_IDS = [
  "web-components.layer-list",
  "web-components.legend",
  "web-components.feature-table",
  "web-components.search",
  "web-components.editor",
  "web-components.chart",
  "web-components.basemap-control",
  "web-components.bookmarks",
  "web-components.locate-control",
  "web-components.measure-control",
  "web-components.sketch-control",
  "web-components.print-export",
  "web-components.map-status",
  "web-components.action-panel",
] as const;

const LIFECYCLE_HARNESS = "test/web-components-lifecycle-gates.test.ts";
const SSR_IMPORT_SUITE = "test/web-components-ssr-import.test.ts";
const BROWSER_SPEC = "test/playwright/web-components-basic.spec.mjs";

/**
 * Read-only presentations: a legend and a chart render no interactive control in
 * any state, so the interaction-driven gates have nothing to bind to. The
 * harness asserts this in both directions, so adding an affordance to either
 * forces these rows to move.
 */
const DISPLAY_ONLY_IDS = ["web-components.legend", "web-components.chart"] as const;
const CONTROLS_DISPLAY_ONLY_IDS = ["controls.legend"] as const;

/** Harness tags that carry a real interactive affordance. */
const INTERACTIVE_HARNESS_IDS = LIFECYCLE_HARNESS_IDS.filter(
  (id) => !DISPLAY_ONLY_IDS.includes(id as (typeof DISPLAY_ONLY_IDS)[number]),
);

/**
 * Harness tags whose focused control survives a re-render. Determined
 * empirically by the harness, which requires the complement to *lose* focus, so
 * this set cannot drift away from observed behavior.
 */
const FOCUS_RESTORING_IDS = [
  "web-components.layer-list",
  "web-components.feature-table",
  "web-components.editor",
  "web-components.basemap-control",
  "web-components.bookmarks",
  "web-components.measure-control",
  "web-components.sketch-control",
  "web-components.print-export",
  "web-components.action-panel",
  "web-components.locate-control",
  "web-components.map-status",
  // The search element's *text input* — the case that actually matters — is
  // covered by the harness's dedicated text-field suite.
  "web-components.search",
] as const;

/** No harness-covered interactive component currently loses focus across a re-render. */
const FOCUS_LOSING_IDS = [] as const;

/** Components that move the map camera and would need to honour reduced motion. */
const CAMERA_MOVING_IDS = [
  "web-components.map",
  "web-components.search",
  "web-components.bookmarks",
  "web-components.locate-control",
] as const;

interface QualificationGroup {
  readonly ids: readonly string[];
  readonly evidence?: readonly string[];
  readonly note?: string;
}

interface GateDeclaration {
  readonly passing?: readonly QualificationGroup[];
  readonly failing?: readonly QualificationGroup[];
  readonly notApplicable?: readonly QualificationGroup[];
  /** Note attached to every cell this gate leaves at `pending`. */
  readonly pendingNote?: string;
}

const DECLARATIONS: Readonly<Record<HonuaComponentQualificationGateId, GateDeclaration>> = {
  "keyboard-behavior": {
    passing: [
      {
        ids: ["web-components.map"],
        evidence: [BROWSER_SPEC],
        note: "The focused zoom control receives a real Enter key event and produces the same viewport event count as its pointer-activation baseline in the browser fixture.",
      },
      {
        ids: [
          "web-components.basemap-control",
          "web-components.bookmarks",
          "web-components.locate-control",
          "web-components.print-export",
          "web-components.action-panel",
          "web-components.map-status",
          "web-components.measure-control",
          "web-components.sketch-control",
          "web-components.editor",
          "controls.basemap-switcher",
          "controls.layer-list",
        ],
        evidence: [BROWSER_SPEC],
        note: "The browser fixture dispatches real Space/Enter key events to each component's native checkbox, radio, or button and asserts the resulting layer, basemap, viewport, locate, export, or refresh state.",
      },
      {
        ids: ["web-components.search"],
        evidence: ["test/web-components-search-element.test.ts"],
        note: "ArrowDown/ArrowUp/Enter/Escape are dispatched as real KeyboardEvents against the combobox and the resulting suggestion, selection, and viewport changes are asserted.",
      },
      {
        ids: ["web-components.measurement"],
        evidence: ["test/web-components-measurement-element.test.ts"],
        note: "Escape cancels an in-progress measurement via a real keydown.",
      },
      {
        ids: ["web-components.layer-list"],
        evidence: [BROWSER_SPEC],
        note: "The controller-driven layer list is exercised in Chromium with a focused visibility checkbox activated by Space and a focused reorder button activated by Enter; controller visibility/order state and the re-rendered shadow rows are asserted.",
      },
      {
        ids: ["controls.swipe-control"],
        evidence: ["test/controls/swipe-control.test.ts"],
        note: "ArrowLeft/ArrowRight (with and without Shift), Home, and End step the divider and emit change.",
      },
      {
        ids: [FEATURE_TABLE],
        evidence: [FEATURE_TABLE_SUITE, BROWSER_SPEC],
        note: "The kit's strongest keyboard coverage: ArrowDown/Enter/Tab dispatched as real KeyboardEvents against both the controller lane and the bounded engine lane, asserting the resulting focus move, selection, and — for Tab — that the grid does not preventDefault a key the page owns. Also verified end to end in a real browser. Not yet dispatched as DOM events: Home/End, Ctrl+Home/Ctrl+End, PageUp/PageDown, Space, and Shift+click additive sort; the key-to-move mapping behind the paging keys is unit-tested separately, so the gap is the DOM delivery path rather than the behavior.",
      },
      {
        ids: [FEATURE_EDITOR],
        evidence: [FEATURE_EDITOR_SUITE],
        note: "Ctrl+Z / Ctrl+Shift+Z drive undo and redo and Escape cancels the draft, each dispatched as a real KeyboardEvent with the resulting workflow state asserted. The events are dispatched at the shadow root rather than from a focused control, so the root-level handler is proven but focus-based delivery is not.",
      },
    ],
    notApplicable: [
      {
        ids: [...DISPLAY_ONLY_IDS, ...CONTROLS_DISPLAY_ONLY_IDS],
        note: "These legend and chart components render display-only content and expose no interactive affordance for keyboard operation; adding one would require this row to be re-qualified.",
      },
    ],
    pendingNote:
      "No key event is dispatched against this component in any suite. Where a test names keyboard operation it currently asserts a synthetic click on a natively focusable button, which proves the affordance exists but not that key handling works. jsdom does not implement a button's Enter/Space activation behavior, so this gate can only be closed in the browser lane for elements whose controls are plain buttons.",
  },

  "screen-reader-semantics": {
    passing: [
      {
        ids: ["web-components.search"],
        evidence: ["test/web-components-search-element.test.ts"],
        note: "Full ARIA combobox contract: role, aria-autocomplete, aria-expanded, aria-controls, aria-activedescendant, listbox/option roles, aria-selected, and a role=status live region — plus the plain-textbox contract when no geocoder is assigned.",
      },
      {
        ids: ["web-components.measurement"],
        evidence: ["test/web-components-measurement-element.test.ts"],
        note: "role=group mode set with aria-pressed state and a role=status aria-live=polite readout.",
      },
      {
        ids: ["web-components.legend", "controls.legend"],
        evidence: ["test/web-components-legend-element.test.ts", "test/controls/legend.test.ts"],
        note: "List/listitem roles with aria-hidden swatches, asserted in both kits' implementations of honua-legend.",
      },
      {
        ids: ["web-components.layer-list"],
        evidence: ["test/web-components-layer-list-element.test.ts"],
        note: "list/listitem roles per layer row plus accessible names on the opacity slider and reorder controls.",
      },
      {
        ids: ["web-components.measure-control", "web-components.sketch-control"],
        evidence: ["test/web-components-measure-sketch-elements.test.ts"],
        note: "The provider-absent affordance is asserted to carry aria-disabled=true rather than a silently inert button.",
      },
      {
        ids: ["web-components.print-export"],
        evidence: [LIFECYCLE_HARNESS],
        note: "The outcome readout is a role=status aria-live=polite region that names the adapter requirement, and an export with no adapter carries an explanatory title. Deliberately neither disabled nor aria-disabled: both suppress activation, and activation is how an application discovers it must supply an adapter — the asserted behavior is that activating an unavailable export still reports the unsupported outcome through honua-export.",
      },
      {
        ids: [FEATURE_EDITOR],
        evidence: [FEATURE_EDITOR_SUITE],
        note: "The kit's most complete accessibility contract: per-field label association, aria-required, aria-invalid with aria-describedby resolving to the validation text, role=alert on validation/conflict/failure regions, aria-pressed on operation and sketch-tool toggles, aria-disabled on unavailable actions, role=group with an accessible name on the tool groups, and a role=status aria-live=polite readout.",
      },
      {
        ids: [FEATURE_TABLE],
        evidence: [FEATURE_TABLE_SUITE],
        note: "A full WAI-ARIA grid contract: role=grid/row/columnheader/gridcell with absolute aria-rowcount, aria-colcount, aria-rowindex, and aria-colindex across a virtualized window, aria-rowcount=-1 when the true total is genuinely unknown rather than a fabricated number, aria-sort, aria-selected, aria-busy, a role=status aria-live=polite readout, and placeholder rows that announce nothing they cannot substantiate. The grid's own accessible name (aria-labelledby) is emitted but not asserted.",
      },
      {
        ids: ["controls.basemap-switcher", "controls.swipe-control", "controls.layer-list"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "The native controls expose explicit accessible structure: a labelled radiogroup with checked radio choices, a labelled slider with bounded value state, and a labelled group containing native checkbox controls paired with their visible labels.",
      },
      {
        ids: [
          "web-components.map",
          "web-components.editor",
          "web-components.chart",
          "web-components.basemap-control",
          "web-components.bookmarks",
          "web-components.locate-control",
          "web-components.map-status",
          "web-components.action-panel",
        ],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The web components expose named panels or regions, native action controls with accessible names, and live status content where component state changes are announced.",
      },
    ],
    pendingNote:
      "No role, accessible-name, or ARIA-state assertion exists for this component. Several are exercised by role-based Playwright locators on the browser fixture page, which depends on accessible names but does not assert the full semantic contract.",
  },

  "focus-restoration": {
    passing: [
      {
        ids: FOCUS_RESTORING_IDS,
        evidence: [LIFECYCLE_HARNESS],
        note: "The shared setShadowHtml() capture/restore path is asserted per tag: the focused control survives a controller-driven re-render. For the search element the covered case is its text input, which additionally keeps its typed value and selection range.",
      },
      {
        ids: ["web-components.search"],
        evidence: ["test/web-components-search-element.test.ts", BROWSER_SPEC],
        note: "Also verified end to end in a real browser: the search input keeps focus across the re-render that follows a suggestion commit.",
      },
      {
        ids: [FEATURE_TABLE],
        evidence: [FEATURE_TABLE_SUITE],
        note: "Stronger than the harness's generic check: the exact cell keeps focus across the re-render that focusing itself causes, via a data-cell-key attribute deliberately ordered ahead of data-field so the base class's alphabetical data-* scan selects the cell rather than the column. The roving tabindex is restored with it, and rows are asserted to stay out of the tab sequence so the grid keeps a single tab stop.",
      },
      {
        ids: [FEATURE_EDITOR],
        evidence: [FEATURE_EDITOR_SUITE],
        note: "A reconciling realtime change forces a re-render and the focused field keeps its edited value, its focus, and its caret range. Covered for text inputs only: this element hand-rolls its own captureFocus() keyed on `id` alone rather than using the shared setShadowHtml() helper's id/name/data-* selector, and none of its buttons carry an id, so button focus is silently lost across the same re-render.",
      },
      {
        ids: ["controls.basemap-switcher", "controls.swipe-control"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "A focused basemap radio and swipe divider retain focus across their state rerenders.",
      },
      {
        ids: ["web-components.measurement"],
        evidence: ["test/web-components-measurement-element.test.ts"],
        note: "The focused measurement mode button retains focus when the mode state rerenders.",
      },
      {
        ids: ["web-components.map"],
        evidence: [BROWSER_SPEC],
        note: "A focused zoom control retains focus across repeated controller-driven map state updates in the real MapLibre browser fixture.",
      },
      {
        ids: ["controls.layer-list"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "A focused layer checkbox retains focus across an overlays rerender.",
      },
    ],
    failing: [
      {
        ids: FOCUS_LOSING_IDS,
        note: "Focus is lost across a re-render, asserted by the harness rather than assumed: this element's control carries no id, name, or non-empty data-* attribute, so the base class's focusSelector() cannot find it again after innerHTML is replaced. The search element's submit button has the same defect, though its text input (the case that matters) is covered.",
      },
    ],
    notApplicable: [
      {
        ids: DISPLAY_ONLY_IDS,
        note: "A read-only presentation with no focusable control; there is no active element to preserve. The harness asserts the absence, so adding an affordance moves this row.",
      },
      {
        ids: CONTROLS_DISPLAY_ONLY_IDS,
        note: "The native legend is a read-only list presentation with no focusable control; there is no active element to preserve.",
      },
    ],
    pendingNote:
      "The controls kit renders through its own template path rather than the web-components base class's capture/restore helper, and no test asserts focus survives a re-render there.",
  },

  "reduced-motion": {
    passing: [
      {
        ids: CAMERA_MOVING_IDS,
        evidence: ["test/runtime/runtime.test.ts"],
        note: "The shared runtime forces animated bounding-box camera transitions to animate:false when the map container reports prefers-reduced-motion: reduce, covering all four web components that delegate camera commits through this path.",
      },
    ],
    notApplicable: [
      {
        ids: ALL_IDS.filter((id) => !CAMERA_MOVING_IDS.includes(id as (typeof CAMERA_MOVING_IDS)[number])),
        note: "The component owns no animation: its shadow styles declare no transition, animation, or keyframes, and it does not move the map camera. There is nothing for prefers-reduced-motion to suppress. Re-evaluate if animated affordances are added.",
      },
    ],
  },

  "high-contrast": {
    passing: [
      {
        ids: [FEATURE_EDITOR],
        evidence: [FEATURE_EDITOR_SUITE],
        note: "The feature editor declares forced-colors and prefers-contrast styles for pressed, disabled, native form, invalid, and validation states, with the emitted stylesheet assertions covering system Canvas/Highlight colors and non-color state distinctions.",
      },
      {
        ids: ["controls.swipe-control"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "The swipe divider declares forced-colors and prefers-contrast rules that preserve the divider and handle boundary using ButtonText/Canvas system colors, asserted from the emitted shadow stylesheet.",
      },
      {
        ids: ["controls.layer-list"],
        evidence: ["test/controls/layer-list.test.ts"],
        note: "The native layer list declares forced-colors and prefers-contrast rules that preserve checked-row distinction with a CanvasText outline and unseeded-row distinction with GrayText, asserted from the component stylesheet.",
      },
      {
        ids: ["controls.basemap-switcher"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "The native basemap switcher declares a forced-colors/prefers-contrast Highlight outline for the active radio, asserted from the emitted stylesheet.",
      },
      {
        ids: ["controls.legend"],
        evidence: ["test/controls/legend.test.ts"],
        note: "The native legend declares forced-colors/prefers-contrast system-color rules for swatches and the empty state, asserted from the component stylesheet.",
      },
      {
        ids: ["web-components.search"],
        evidence: ["test/web-components-search-element.test.ts"],
        note: "The search component declares forced-colors/prefers-contrast system-color rules for borders and selected suggestions, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.legend"],
        evidence: ["test/web-components-legend-element.test.ts"],
        note: "The web-component legend declares forced-colors/prefers-contrast system-color rules that preserve swatch boundaries and label contrast, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.map-status"],
        evidence: ["test/web-components-map-status-element.test.ts"],
        note: "The map-status panel declares forced-colors/prefers-contrast Canvas/CanvasText/ButtonText/GrayText/Mark system-color rules for normal, unsupported, error, and action states, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.action-panel"],
        evidence: ["test/web-components-action-panel-element.test.ts"],
        note: "The action panel declares forced-colors/prefers-contrast system-color rules for panel, action, empty, and status states, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.layer-list"],
        evidence: ["test/web-components-layer-list-element.test.ts"],
        note: "The web-component layer list declares forced-colors/prefers-contrast system-color rules for row boundaries, checked labels, and reorder controls, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.bookmarks"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The bookmarks control panel declares forced-colors/prefers-contrast Canvas/CanvasText/ButtonFace/ButtonText rules for its surface and action buttons, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.basemap-control"],
        evidence: ["test/web-components-basemap-control-element.test.ts"],
        note: "The web basemap control declares forced-colors/prefers-contrast system-color rules for active radio state and controls, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.locate-control"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The locate control's shared panel declares forced-colors/prefers-contrast Canvas/CanvasText/ButtonFace/ButtonText rules for its surface and action, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.measure-control", "web-components.sketch-control"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The measure and sketch controls' shared panels declare forced-colors/prefers-contrast Canvas/CanvasText/ButtonFace/ButtonText rules, asserted from each emitted stylesheet.",
      },
      {
        ids: ["web-components.print-export"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The print/export control declares forced-colors/prefers-contrast system-color rules for its panel and export actions, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.editor"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The web editor declares forced-colors/prefers-contrast Canvas/CanvasText/ButtonText rules for its panel and native actions, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.measurement"],
        evidence: ["test/web-components-measurement-element.test.ts"],
        note: "The measurement element declares forced-colors/prefers-contrast system-color rules for its mode/status surface, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.chart"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The chart declares forced-colors/prefers-contrast Canvas/CanvasText/ButtonFace/ButtonText/Highlight rules for its panel and bars, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.feature-table"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The feature table declares forced-colors/prefers-contrast Canvas/CanvasText/Highlight rules for panel, headers, selected rows, and focus, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.map"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The map declares forced-colors/prefers-contrast Canvas/CanvasText/ButtonText rules for its panel, chrome, canvas, status, and controls, asserted from the emitted stylesheet.",
      },
    ],
    failing: [
      {
        ids: ALL_IDS.filter(
          (id) =>
            id !== FEATURE_EDITOR &&
            id !== "controls.swipe-control" &&
            id !== "controls.layer-list" &&
            id !== "controls.basemap-switcher" &&
            id !== "controls.legend" &&
            id !== "web-components.search" &&
            id !== "web-components.legend" &&
            id !== "web-components.map-status" &&
            id !== "web-components.action-panel" &&
            id !== "web-components.layer-list" &&
            id !== "web-components.bookmarks" &&
            id !== "web-components.basemap-control" &&
            id !== "web-components.locate-control" &&
            id !== "web-components.measure-control" &&
            id !== "web-components.sketch-control" &&
            id !== "web-components.print-export" &&
            id !== "web-components.editor" &&
            id !== "web-components.measurement" &&
            id !== "web-components.chart" &&
            id !== "web-components.feature-table" &&
            id !== "web-components.map",
        ),
        note: "Shadow styles hard-code foreground/background/border colors with no forced-colors: active or prefers-contrast: more block, so state conveyed by color (selected rows, pressed modes, legend swatches, disabled buttons) collapses under a forced-colors palette.",
      },
    ],
  },

  "responsive-layout": {
    passing: [
      {
        ids: ["web-components.search"],
        evidence: ["test/web-components-search-element.test.ts"],
        note: "The search form uses a shrinkable grid and stacks its submit button full-width below 320px, asserted from the emitted stylesheet for narrow-container behavior.",
      },
      {
        ids: ["controls.basemap-switcher"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "The native basemap switcher stacks its wrapped group and ellipsizes radio labels below 240px, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.map-status"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The map-status row stacks its content and makes the action full-width below 240px, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.feature-table"],
        evidence: ["test/web-components-feature-table-element.test.ts"],
        note: "The feature table keeps its panel shrinkable and exposes horizontal scrolling for narrow containers, with an overflow-safe table width, asserted from the emitted stylesheet.",
      },
      {
        ids: ["web-components.editor"],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "The editor panel makes its action row wrap and its buttons shrink below 320px, asserted from the emitted stylesheet.",
      },
    ],
    failing: [
      {
        ids: ALL_IDS.filter(
          (id) =>
            id !== "web-components.search" &&
            id !== "controls.basemap-switcher" &&
            id !== "web-components.map-status" &&
            id !== "web-components.feature-table" &&
            id !== "web-components.editor",
        ),
        note: "No component declares an @media or @container rule; panel and table layouts are fixed, so narrow containers clip content or force horizontal overflow. The repo's responsive attestation harness is wired to the sample apps, not to the component kit.",
      },
    ],
  },

  localization: {
    passing: [
      {
        ids: ["controls.basemap-switcher"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "The basemap switcher accepts a caller-supplied non-English group label and emits it as the radiogroup accessible name; individual basemap names are supplied by the base definitions.",
      },
      {
        ids: ["controls.swipe-control"],
        evidence: ["test/controls/swipe-control.test.ts"],
        note: "The swipe control has no default accessible label and reflects caller-supplied label text through its public property/attribute into aria-label, asserted with French and German labels.",
      },
    ],
    failing: [
      {
        ids: allExcept("web-components.search", "controls.basemap-switcher", "controls.swipe-control"),
        note: "Every user-visible string is a hard-coded English literal inside the render template (button labels, status words, empty-state copy, accessible names). There is no message source to inject and no locale plumbing in either kit.",
      },
      {
        ids: ["web-components.search"],
        note: "The submit action is caller-localizable through the reflected submitLabel property / submit-label attribute, with the legacy English `Search` default preserved and a non-English rendering assertion. The component still owns hard-coded placeholder, suggestion, no-result, and geocoding status strings, so the full localization criterion remains failing for this component.",
      },
    ],
  },

  "pseudo-locale": {
    failing: [
      {
        ids: ALL_IDS,
        note: "Blocked on the localization gate: with no externalized messages there is nothing to render under a pseudo-locale, and the fixed layouts have no tested tolerance for the ~35% string growth real translation causes.",
      },
    ],
  },

  rtl: {
    passing: [
      {
        ids: [FEATURE_EDITOR],
        evidence: [FEATURE_EDITOR_SUITE],
        note: "The feature editor renders flex/grid surfaces without physical left/right declarations; an explicit dir=rtl fixture asserts the emitted stylesheet remains direction-neutral.",
      },
      {
        ids: ["controls.swipe-control"],
        evidence: ["test/controls/swipe-control.test.ts"],
        note: "The swipe control uses logical divider positioning, reverses inline pointer and keyboard movement in RTL, and asserts the RTL clip path and Home/End semantics in focused tests.",
      },
      {
        ids: ["controls.layer-list"],
        evidence: ["test/controls/layer-list.test.ts"],
        note: "The native layer list renders direction-neutral flex rows under an explicit dir=rtl fixture and has no physical left/right style declarations.",
      },
      {
        ids: ["controls.basemap-switcher"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "The native basemap switcher is rendered with dir=rtl and its emitted structural styles contain no physical left/right declarations.",
      },
    ],
    failing: [
      {
        ids: allExcept(FEATURE_EDITOR, "controls.swipe-control", "controls.layer-list", "controls.basemap-switcher"),
        note: "Styles use physical left/right offsets and margins rather than logical inline-start/inline-end properties, and no test renders any component under dir=rtl.",
      },
    ],
    pendingNote:
      "No verdict rather than a known failure, which is the honest distinction for this component: unlike the rest of the kit its styles declare no physical left/right offsets at all, so it is not demonstrably RTL-hostile. It also uses no logical properties and nothing renders it under dir=rtl, so it is simply unverified.",
  },

  "visual-regression": {
    pendingNote:
      "The kit has no reference screenshots. The repo's only screenshot comparison covers a sample app; component-spec screenshots are captured as evidence attachments only and are never compared.",
  },

  "strict-csp": {
    failing: [
      {
        ids: ALL_IDS,
        note: "Every render assigns shadowRoot.innerHTML with an inline <style> block, which a policy without style-src 'unsafe-inline' blocks — the component would render unstyled. Some templates also carry inline style attributes. No test serves the components under a policy, so this is a code-level finding rather than an enforced gate.",
      },
    ],
  },

  "zero-console-error": {
    passing: [
      {
        ids: LIFECYCLE_HARNESS_IDS,
        evidence: [LIFECYCLE_HARNESS],
        note: "console.error and console.warn are spied for the whole mount / drive / re-render / unmount cycle and asserted never to be called.",
      },
      {
        ids: [FEATURE_TABLE],
        evidence: [LIFECYCLE_HARNESS],
        note: "Covered for the controller lane only. The bounded engine lane is not driven by the harness and no feature-table suite spies on the console, so its query, paging, and conflict paths are unswept.",
      },
      {
        ids: [
          "web-components.map",
          "web-components.editor",
          "web-components.chart",
          "web-components.basemap-control",
          "web-components.bookmarks",
          "web-components.locate-control",
          "web-components.map-status",
          "web-components.action-panel",
        ],
        evidence: ["test/web-components-accessibility.test.ts"],
        note: "Each covered web component is mounted and disconnected while console.error and console.warn are spied; the complete lifecycle emits neither.",
      },
      {
        ids: ["controls.basemap-switcher", "controls.swipe-control", "controls.legend", "controls.layer-list"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "Each native control is mounted and disconnected while console.error and console.warn are spied; the complete lifecycle emits neither.",
      },
      {
        ids: ["web-components.feature-editor"],
        evidence: ["test/web-components-feature-editor-element.test.ts"],
        note: "The feature editor is mounted and disconnected while console.error and console.warn are spied; its complete lifecycle emits neither.",
      },
      {
        ids: ["web-components.measurement"],
        evidence: ["test/web-components-measurement-element.test.ts"],
        note: "The measurement element is mounted and disconnected while console.error and console.warn are spied; its complete lifecycle emits neither.",
      },
    ],
    pendingNote:
      "Only uncaught-exception capture (Playwright pageerror) covers this component; the repo's console-error assertion helper is not applied to any component spec.",
  },

  "deterministic-disposal": {
    passing: [
      {
        ids: LIFECYCLE_HARNESS_IDS,
        evidence: [LIFECYCLE_HARNESS],
        note: "Removing the element drops its controller state subscription and its root honua-controller-ready listener to zero, and a subsequent controller update reaches no detached element.",
      },
      {
        ids: ["web-components.measurement"],
        evidence: ["test/web-components-measurement-element.test.ts"],
        note: "Disconnecting unbinds every map listener and restores double-click zoom.",
      },
      {
        ids: ["controls.legend", "controls.layer-list"],
        evidence: ["test/controls/legend.test.ts", "test/controls/layer-list.test.ts"],
        note: "The auto-refresh styledata subscription is dropped on disconnect and re-established on reconnect.",
      },
      {
        ids: ["controls.basemap-switcher"],
        evidence: ["test/controls/basemap-switcher.test.ts"],
        note: "Unbinding the map removes every layer and source the control added, and reconnecting restores the selection.",
      },
      {
        ids: ["controls.swipe-control"],
        evidence: ["test/controls/swipe-control.test.ts"],
        note: "Disconnecting during an active drag removes the pointermove, pointerup, and pointercancel listeners it installed.",
      },
      {
        ids: ["web-components.map"],
        evidence: [BROWSER_SPEC],
        note: "Removing the element tears down canvas, map, and runtime, asserted in a real browser. Unit-level coverage is not possible without a renderer.",
      },
      {
        ids: [FEATURE_TABLE],
        evidence: [FEATURE_TABLE_SUITE, LIFECYCLE_HARNESS],
        note: "Both lanes are covered: the controller subscription and root controller-ready listener (harness), and the bounded engine subscription — released on detach, re-taken exactly once on reconnect, with a re-assignment asserted not to double-subscribe and a reconnect asserted not to re-query. Its grid listeners are bound to nodes that the next innerHTML render replaces, so unlike the feature editor's former shadow-root binding they neither accumulate nor survive as a live handler. Still uncovered: the element does not cancel an in-flight engine refresh on disconnect (the engine is host-owned and cancels on its own dispose), and no test asserts that.",
      },
      {
        ids: [FEATURE_EDITOR],
        evidence: [FEATURE_EDITOR_SUITE],
        note: "Complete for what this element owns: the workflow subscription is released on disconnect and re-taken on reconnect, and the shadow-root keydown listener is released too — asserted by dispatching at the detached element's still-live shadow root and counting zero workflow calls, then exactly one after reconnect, and still exactly one after three detach/reattach cycles (issue #809). The element holds no timers and no AbortController of its own, so there is nothing further to release.",
      },
    ],
    pendingNote: "Nothing asserts what this component releases when it is disconnected.",
  },

  "duplicate-listener": {
    passing: [
      {
        ids: INTERACTIVE_HARNESS_IDS,
        evidence: [LIFECYCLE_HARNESS],
        note: "After ten controller-driven re-renders a single interaction still produces the same (non-zero) number of events it did after the first render, proving handlers are bound to freshly rendered nodes rather than accumulated on surviving ones.",
      },
      {
        ids: [FEATURE_TABLE],
        evidence: [LIFECYCLE_HARNESS, FEATURE_TABLE_SUITE],
        note: "Covered through the controller lane by the harness, and the bounded lane binds every grid handler to nodes the next render replaces rather than to the persistent shadow root, which is the arrangement that makes accumulation impossible. The bounded lane's scroll, cell-focus, and sort-button handlers are not themselves swept across repeated renders.",
      },
      {
        ids: [FEATURE_EDITOR],
        evidence: [FEATURE_EDITOR_SUITE],
        note: "One keystroke after four re-renders drives exactly one undo, one redo, and one cancel, asserted by counting workflow invocations rather than resulting state — which is the only way to see this defect class, since surplus undo()/cancel() calls are idempotent no-ops that leave state looking correct. The keydown listener is now bound once per connection on the shadow root instead of on every render (issue #809).",
      },
      {
        ids: ["web-components.measurement"],
        evidence: ["test/web-components-measurement-element.test.ts"],
        note: "Repeated mode rerenders leave exactly one map click and one double-click listener, proving handlers are not accumulated.",
      },
      {
        ids: ["controls.basemap-switcher"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "Repeated bases rerenders leave one click handler on the selected radio, evidenced by exactly one change event from one interaction.",
      },
      {
        ids: ["controls.swipe-control"],
        evidence: ["test/controls/swipe-control.test.ts"],
        note: "Repeated position rerenders leave one keyboard handler on the divider, evidenced by exactly one change event from one ArrowRight interaction.",
      },
      {
        ids: ["controls.layer-list"],
        evidence: ["test/controls/accessibility.test.ts"],
        note: "Repeated overlays rerenders leave one checkbox change handler, evidenced by exactly one change event from one click.",
      },
      {
        ids: ["web-components.map"],
        evidence: [BROWSER_SPEC],
        note: "After repeated controller-driven state updates, one zoom click produces the same viewport event count as the pre-update baseline in the real MapLibre browser fixture.",
      },
    ],
    notApplicable: [
      {
        ids: DISPLAY_ONLY_IDS,
        note: "A read-only presentation that binds no event handler; there is nothing that could accumulate. The harness asserts the absence of any interactive control, so adding one moves this row.",
      },
      {
        ids: CONTROLS_DISPLAY_ONLY_IDS,
        note: "The native legend binds no event handler because it is a read-only list presentation; there is nothing that could accumulate.",
      },
    ],
    pendingNote:
      "No test re-renders this component and asserts handler count. The existing bind/unbind assertions walk a collaborator's listener count 0 -> 1 -> 0, which is adjacent but does not catch double-add on repeated render.",
  },

  "memory-leak": {
    pendingNote:
      "No WeakRef or heap-retention probe exists for either kit. Deterministic disposal is the necessary precondition and is covered separately; actual non-retention is unproven.",
  },

  "ssr-import": {
    passing: [
      {
        ids: ALL_IDS,
        evidence: [SSR_IMPORT_SUITE],
        note: "Both kit entrypoints, the element module, the catalog, and the registry are imported in a DOM-free Node environment with window and document asserted absent; no custom element is defined and no browser global is touched at module scope.",
      },
    ],
  },

  "bundle-budget": {
    passing: [
      {
        ids: ALL_IDS,
        evidence: ["bundle-budgets.json", "scripts/report-bundle-sizes.mjs"],
        note: "The owning kit's entrypoint (/controls or /web-components) carries a declared min+gzip ceiling enforced by npm run verify:bundle-budgets, with maplibre-gl, cesium, deck.gl, PDF/image encoders, and localization frameworks declared as forbidden static inputs (NFR-001).",
      },
    ],
  },
};

// ── expansion + queries ──────────────────────────────────────────────────

function statusFor(gate: HonuaComponentQualificationGateId, id: string): HonuaComponentQualificationCell {
  const declaration = DECLARATIONS[gate];
  const definition = HONUA_COMPONENT_QUALIFICATION_GATES.find((entry) => entry.id === gate);
  if (!definition) throw new Error(`Unknown qualification gate "${gate}".`);
  const base = { gate, requirement: definition.requirement } as const;
  for (const [status, groups] of [
    ["passing", declaration.passing],
    ["failing", declaration.failing],
    ["not-applicable", declaration.notApplicable],
  ] as const) {
    const matches = (groups ?? []).filter((group) => group.ids.includes(id));
    if (matches.length === 0) continue;
    const evidence = [...new Set(matches.flatMap((group) => group.evidence ?? []))].sort();
    const notes = matches.map((group) => group.note).filter((note): note is string => Boolean(note));
    return {
      ...base,
      status,
      evidence,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }
  return {
    ...base,
    status: "pending",
    evidence: [],
    ...(declaration.pendingNote ? { note: declaration.pendingNote } : {}),
  };
}

/** The full matrix row for one catalog id, or `undefined` for an unknown id. */
export function getComponentQualification(id: string): HonuaComponentQualification | undefined {
  const entry = HONUA_COMPONENT_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) return undefined;
  return {
    id: entry.id,
    tag: entry.tag,
    source: entry.source,
    gates: HONUA_COMPONENT_QUALIFICATION_GATES.map((gate) => statusFor(gate.id, entry.id)),
  };
}

/** The full matrix, in catalog order. */
export function listComponentQualifications(): readonly HonuaComponentQualification[] {
  return HONUA_COMPONENT_CATALOG.map((entry) => {
    const qualification = getComponentQualification(entry.id);
    if (!qualification) throw new Error(`Catalog entry "${entry.id}" has no qualification row.`);
    return qualification;
  });
}

/** One gate's definition. */
export function describeComponentQualificationGate(
  gate: HonuaComponentQualificationGateId,
): HonuaComponentQualificationGate | undefined {
  return HONUA_COMPONENT_QUALIFICATION_GATES.find((entry) => entry.id === gate);
}

/** Counts and remaining blockers for one row, or for the whole matrix when `id` is omitted. */
export function summarizeComponentQualification(id?: string): HonuaComponentQualificationSummary {
  const rows = id ? [getComponentQualification(id)].filter((row) => row !== undefined) : listComponentQualifications();
  const cells = rows.flatMap((row) => row.gates);
  const blocking = new Set<HonuaComponentQualificationGateId>();
  for (const cell of cells) {
    if (cell.status === "failing" || cell.status === "pending") blocking.add(cell.gate);
  }
  return {
    passing: cells.filter((cell) => cell.status === "passing").length,
    failing: cells.filter((cell) => cell.status === "failing").length,
    pending: cells.filter((cell) => cell.status === "pending").length,
    notApplicable: cells.filter((cell) => cell.status === "not-applicable").length,
    blocking: [...blocking].sort(),
  };
}

/**
 * Whether a component has cleared **every** gate in this matrix.
 *
 * `not-applicable` cells count as cleared (that is what the status means, and
 * why it requires a justifying note); `pending` and `failing` do not.
 *
 * This is deliberately *not* the same claim as the catalog's
 * `supportTier: "production-tier"`, and conflating the two would misreport both.
 * The catalog tier is a **functional maturity** claim owned by whichever feature
 * issue raised the component (#680-#683): `<honua-feature-editor>` is
 * production-tier because #680 delivered capability-aware editing, conflict
 * handling, snapping, and attachment staging on it. This function is the
 * **cross-cutting gate** axis, which no component has cleared yet.
 *
 * `scripts/component-qualification.mjs` therefore enforces only the direction
 * that is actually implied: a component that has cleared every gate must be
 * declared production-tier, because gate completion is strictly the harder bar.
 * The reverse does not hold, so a production-tier component simply carries its
 * still-open gates in the manifest's `openGates` — visible, counted, and
 * impossible to mistake for done. See {@link listOpenQualificationGates}.
 */
export function isComponentProductionQualified(id: string): boolean {
  const qualification = getComponentQualification(id);
  if (!qualification) return false;
  return qualification.gates.every((cell) => cell.status === "passing" || cell.status === "not-applicable");
}

/**
 * The gates a component has not yet cleared (`pending` or `failing`), in gate
 * order. Empty exactly when {@link isComponentProductionQualified} is true.
 *
 * This is what keeps a `production-tier` catalog claim honest: the tier says the
 * component's *feature* work landed, and this says precisely what remains on the
 * accessibility, localization, visual, CSP, lifecycle, and bundle axes.
 */
export function listOpenQualificationGates(id: string): readonly HonuaComponentQualificationGateId[] {
  const qualification = getComponentQualification(id);
  if (!qualification) return [];
  return qualification.gates
    .filter((cell) => cell.status === "pending" || cell.status === "failing")
    .map((cell) => cell.gate);
}
