// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Capability, EditEnvelope, EditResult, Source } from "../src/contract/types.js";
import { getComponentCatalogEntry } from "../src/controls/catalog.js";
import type {
  HonuaFeatureEditCommitDetail,
  HonuaFeatureEditorElement,
  HonuaFeatureEditorWorkflow,
} from "../src/web-components/index.js";
import { createFeatureEditorWorkflow, defineHonuaWebComponents } from "../src/web-components/index.js";
import type { HonuaEditorSubtypeConfig } from "../src/web-components/index.js";

/**
 * `<honua-feature-editor>` (issue #680) — the rendered surface: a
 * schema/domain/subtype derived form, truthful per-operation state, keyboard
 * geometry entry that never needs the map canvas, screen-reader wiring, focus
 * survival across realtime traffic, and conflict/validation/failure states.
 */

interface PermitAttributes {
  OBJECTID?: number;
  permit_no?: string | null;
  permit_kind?: number | string | null;
  status?: string | null;
  priority?: number | null;
  inspected?: boolean | null;
  version?: number;
  [key: string]: unknown;
}

const SCHEMA_FIELDS = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "Object ID", editable: false, nullable: false },
  { name: "permit_no", type: "esriFieldTypeString", alias: "Permit number", length: 12, nullable: false },
  {
    name: "status",
    type: "esriFieldTypeString",
    alias: "Status",
    domain: {
      type: "codedValue",
      codedValues: [
        { name: "Open", code: "open" },
        { name: "Closed", code: "closed" },
        { name: "Under review", code: "review" },
      ],
    },
  },
  {
    name: "priority",
    type: "esriFieldTypeInteger",
    alias: "Priority",
    domain: { type: "range", range: [1, 5] as [number, number] },
  },
  { name: "inspected", type: "boolean", alias: "Inspected" },
  { name: "version", type: "esriFieldTypeInteger", alias: "Version", editable: false },
];

const SUBTYPES: HonuaEditorSubtypeConfig = {
  field: "permit_kind",
  defaultCode: 1,
  subtypes: [
    {
      code: 1,
      name: "Residential",
      fieldOverrides: {
        status: {
          domain: {
            type: "coded-value",
            codedValues: [
              { name: "Open", code: "open" },
              { name: "Closed", code: "closed" },
            ],
          },
        },
      },
    },
    {
      code: 2,
      name: "Commercial",
      fieldOverrides: {
        status: { domain: { type: "coded-value", codedValues: [{ name: "Under review", code: "review" }] } },
      },
    },
  ],
};

const ok = (
  added: EditResult["added"] = [],
  updated: EditResult["updated"] = [],
  deleted: EditResult["deleted"] = [],
): EditResult => ({ added, updated, deleted });

function makeSource(
  options: {
    capabilities?: readonly Capability[];
    applyEdits?: (envelope: EditEnvelope<PermitAttributes>) => Promise<EditResult>;
  } = {},
): Source<PermitAttributes> {
  const capabilities = new Set<Capability>(options.capabilities ?? ["query", "applyEdits"]);
  return {
    descriptor: {
      id: "permits",
      protocol: "geoservices-feature-service",
      locator: { url: "https://example.test/FeatureServer/0" },
      capabilities,
      schema: { fields: SCHEMA_FIELDS, primaryKey: "OBJECTID" },
    },
    capabilities,
    applyEdits: vi.fn(
      options.applyEdits ??
        (async (envelope: EditEnvelope<PermitAttributes>) => {
          if (envelope.adds?.length) return ok([{ id: 101, success: true }]);
          if (envelope.updates?.length) return ok([], [{ id: envelope.updates[0]?.id ?? 1, success: true }]);
          if (envelope.deletes?.length) return ok([], [], [{ id: envelope.deletes[0], success: true }]);
          return ok();
        }),
    ),
    attachments: {
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => []),
      query: vi.fn(async () => []),
    },
  } as unknown as Source<PermitAttributes>;
}

const feature = () => ({
  id: 1,
  attributes: {
    OBJECTID: 1,
    permit_no: "P-1",
    permit_kind: 1,
    status: "open",
    priority: 3,
    inspected: false,
    version: 7,
  },
  geometry: { type: "Point", coordinates: [1, 2] } as Record<string, unknown>,
});

function mount(workflow: HonuaFeatureEditorWorkflow<PermitAttributes>): HonuaFeatureEditorElement<PermitAttributes> {
  defineHonuaWebComponents();
  const element = document.createElement("honua-feature-editor") as HonuaFeatureEditorElement<PermitAttributes>;
  document.body.append(element);
  element.workflow = workflow;
  return element;
}

function root(element: HonuaFeatureEditorElement<PermitAttributes>): ShadowRoot {
  const shadow = element.shadowRoot;
  if (!shadow) throw new Error("no shadow root");
  return shadow;
}

function query<E extends Element>(element: HonuaFeatureEditorElement<PermitAttributes>, selector: string): E {
  const found = root(element).querySelector<E>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function setControl(element: HonuaFeatureEditorElement<PermitAttributes>, name: string, value: string | boolean): void {
  const control = query<HTMLInputElement | HTMLSelectElement>(element, `[data-field='${name}']`);
  if (typeof value === "boolean") (control as HTMLInputElement).checked = value;
  else control.value = value;
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function statusText(element: HonuaFeatureEditorElement<PermitAttributes>): string {
  return root(element).querySelector("[data-status]")?.textContent ?? "";
}

describe("<honua-feature-editor> registration", () => {
  it("is catalogued as the first production-tier component and registers its tag", () => {
    defineHonuaWebComponents();
    expect(customElements.get("honua-feature-editor")).toBeTypeOf("function");
    expect(getComponentCatalogEntry("web-components.feature-editor")).toMatchObject({
      tag: "honua-feature-editor",
      className: "HonuaFeatureEditorElement",
      supportTier: "production-tier",
      canonical: true,
      events: ["honua-feature-edit-change", "honua-feature-edit-commit"],
    });
  });

  it("renders a labelled empty state without a workflow", () => {
    defineHonuaWebComponents();
    const element = document.createElement("honua-feature-editor") as HonuaFeatureEditorElement<PermitAttributes>;
    element.setAttribute("label", "Permit editor");
    document.body.append(element);
    const panel = root(element).querySelector("[role='region']");
    expect(panel?.getAttribute("aria-label")).toBe("Permit editor");
    expect(root(element).querySelector("[role='status']")?.textContent).toMatch(/No edit workflow/i);
  });
});

describe("<honua-feature-editor> schema-derived form", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("derives every control, label, and choice from public metadata", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");

    const labels = [...root(element).querySelectorAll("label")].map((label) => label.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(["Permit number *", "Status", "Priority", "Inspected"]));

    const status = query<HTMLSelectElement>(element, "[data-field='status']");
    expect(status.tagName).toBe("SELECT");
    expect([...status.options].map((option) => option.value)).toEqual(["open", "closed", ""]);

    const priority = query<HTMLInputElement>(element, "[data-field='priority']");
    expect(priority.type).toBe("number");
    expect(priority.min).toBe("1");
    expect(priority.max).toBe("5");

    expect(query<HTMLInputElement>(element, "[data-field='inspected']").type).toBe("checkbox");
    expect(query<HTMLInputElement>(element, "[data-field='permit_no']").maxLength).toBe(12);
    // Server-assigned fields render, disabled, and are never demanded on create.
    const oid = query<HTMLInputElement>(element, "[data-field='OBJECTID']");
    expect(oid.disabled).toBe(true);
    expect(oid.hasAttribute("required")).toBe(false);
  });

  it("wires each field for a screen reader: label, required, invalid, described-by", async () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");

    const permit = query<HTMLInputElement>(element, "[data-field='permit_no']");
    expect(permit.getAttribute("aria-required")).toBe("true");
    expect(root(element).querySelector(`label[for='${permit.id}']`)).not.toBeNull();
    expect(permit.getAttribute("aria-invalid")).toBe("true");
    const describedBy = permit.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(root(element).querySelector(`#${describedBy}`)?.textContent).toMatch(/Permit number is required/i);
    expect(root(element).querySelector("[data-error-for='permit_no']")).not.toBeNull();
    expect(root(element).querySelector("[data-validation]")?.getAttribute("role")).toBe("alert");
    expect(query<HTMLButtonElement>(element, "[data-action='submit']").disabled).toBe(true);

    setControl(element, "permit_no", "P-9");
    setControl(element, "status", "open");
    setControl(element, "priority", "2");
    expect(query<HTMLInputElement>(element, "[data-field='permit_no']").getAttribute("aria-invalid")).toBeNull();
    expect(root(element).querySelector("[data-validation]")).toBeNull();
    expect(query<HTMLButtonElement>(element, "[data-action='submit']").disabled).toBe(false);
  });

  it("swaps valid choices when the subtype control changes, and rejects a stale value", async () => {
    const source = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    setControl(element, "permit_no", "P-9");
    setControl(element, "priority", "2");
    setControl(element, "status", "open");
    expect(query<HTMLButtonElement>(element, "[data-action='submit']").disabled).toBe(false);

    setControl(element, "permit_kind", "2");
    const status = query<HTMLSelectElement>(element, "[data-field='status']");
    expect([...status.options].map((option) => option.value)).toEqual(["review", ""]);
    expect(root(element).querySelector("[data-error-for='status']")?.textContent).toMatch(/coded-value domain/i);
    expect(query<HTMLButtonElement>(element, "[data-action='submit']").disabled).toBe(true);
    expect(source.applyEdits).not.toHaveBeenCalled();
  });

  it("keeps a read-only source's actions disabled with a truthful reason per operation", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource({ capabilities: ["query"] }) });
    const element = mount(workflow);
    for (const operation of ["create", "update", "delete"]) {
      const button = query<HTMLButtonElement>(element, `[data-operation='${operation}']`);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
    const reasons = [...root(element).querySelectorAll("[data-operation-reason]")].map((li) => li.textContent);
    expect(reasons).toHaveLength(3);
    expect(reasons.join(" ")).toMatch(/does not support editing/i);
    expect(root(element).querySelector("[data-operation-reason='update']")?.getAttribute("data-code")).toBe(
      "capability-unsupported",
    );
  });

  it("shows a partially editable service's per-operation truth", () => {
    const workflow = createFeatureEditorWorkflow({
      source: makeSource(),
      operations: { delete: { available: false, reason: "Permits are archived, never deleted." } },
    });
    const element = mount(workflow);
    workflow.setSelection(feature());
    expect(query<HTMLButtonElement>(element, "[data-operation='update']").disabled).toBe(false);
    expect(query<HTMLButtonElement>(element, "[data-operation='delete']").disabled).toBe(true);
    expect(root(element).querySelector("[data-operation-reason='delete']")?.textContent).toMatch(
      /archived, never deleted/,
    );
  });

  it("marks the active operation pressed and opens the draft from the toolbar", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.setSelection(feature());
    query<HTMLButtonElement>(element, "[data-operation='update']").click();
    expect(query<HTMLButtonElement>(element, "[data-operation='update']").getAttribute("aria-pressed")).toBe("true");
    expect(query<HTMLInputElement>(element, "[data-field='permit_no']").value).toBe("P-1");
    expect(statusText(element)).toMatch(/Editing the selected feature/i);
  });

  it("reports that attachments are unsupported instead of offering a broken control", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    expect(root(element).querySelector("[data-attachments-unsupported]")?.textContent).toMatch(
      /does not support attachments/i,
    );
    expect(root(element).querySelector("[data-attachment-input]")).toBeNull();
  });

  it("offers a file control and lists staged attachments when supported", () => {
    const workflow = createFeatureEditorWorkflow({
      source: makeSource({ capabilities: ["query", "applyEdits", "attachments"] }),
      subtypes: SUBTYPES,
    });
    const element = mount(workflow);
    workflow.begin("create");
    expect(root(element).querySelector("[data-attachment-input]")).not.toBeNull();
    workflow.stageAttachment("https://storage.example.test/plan.pdf?sig=SECRET", { name: "plan.pdf" });
    const staged = root(element).querySelector("[data-attachment-index='0']");
    expect(staged?.textContent).toContain("plan.pdf");
    expect(root(element).innerHTML).not.toContain("SECRET");
  });
});

describe("<honua-feature-editor> keyboard geometry workflow (NFR-001)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("creates and clears geometry entirely from the keyboard, with no map involved", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");

    const textarea = query<HTMLTextAreaElement>(element, "[data-geometry-json]");
    expect(root(element).querySelector(`label[for='${textarea.id}']`)).not.toBeNull();
    textarea.value = '{"type":"Point","coordinates":[10,20]}';
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>(element, "[data-action='apply-geometry']").click();

    expect(workflow.snapshot().sketch?.geometry).toEqual({ type: "Point", coordinates: [10, 20] });
    expect(root(element).querySelector("[data-geometry-state]")?.textContent).toMatch(/Geometry ready/i);

    query<HTMLButtonElement>(element, "[data-action='clear-geometry']").click();
    expect(workflow.snapshot().sketch?.geometry).toBeNull();
    expect(root(element).querySelector("[data-geometry-state]")?.textContent).toMatch(/Geometry cleared/i);
  });

  it("reports invalid geometry input in an alert instead of sending it", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    const textarea = query<HTMLTextAreaElement>(element, "[data-geometry-json]");

    textarea.value = "{not json";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>(element, "[data-action='apply-geometry']").click();
    expect(query(element, "[data-geometry-error]").textContent).toMatch(/not valid JSON/i);
    expect(query(element, "[data-geometry-error]").getAttribute("role")).toBe("alert");

    query<HTMLTextAreaElement>(element, "[data-geometry-json]").value = '{"coordinates":[0,0]}';
    query<HTMLTextAreaElement>(element, "[data-geometry-json]").dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>(element, "[data-action='apply-geometry']").click();
    expect(query(element, "[data-geometry-error]").textContent).toMatch(/needs a "type"/i);

    query<HTMLTextAreaElement>(element, "[data-geometry-json]").value = "  ";
    query<HTMLTextAreaElement>(element, "[data-geometry-json]").dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>(element, "[data-action='apply-geometry']").click();
    expect(query(element, "[data-geometry-error]").textContent).toMatch(/Enter a GeoJSON geometry/i);
    expect(workflow.snapshot().sketch?.geometry).toBeUndefined();
  });

  it("exposes sketch tools as an accessible toggle group with reasons for unsupported ones", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");

    const group = [...root(element).querySelectorAll("[role='group']")].find((node) =>
      node.getAttribute("aria-label")?.includes("sketch tools"),
    );
    expect(group).not.toBeUndefined();
    const polygon = query<HTMLButtonElement>(element, "[data-sketch-tool='polygon']");
    expect(polygon.disabled).toBe(false);
    polygon.click();
    expect(query<HTMLButtonElement>(element, "[data-sketch-tool='polygon']").getAttribute("aria-pressed")).toBe("true");

    const rectangle = query<HTMLButtonElement>(element, "[data-sketch-tool='rectangle']");
    expect(rectangle.disabled).toBe(true);
    expect(rectangle.getAttribute("title")).toMatch(/renderer support/i);
  });

  it("drives undo and redo from the keyboard", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.setSelection(feature());
    workflow.begin("update");
    setControl(element, "status", "closed");
    expect(workflow.snapshot().dirty).toBe(true);

    root(element).dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(workflow.snapshot().dirty).toBe(false);
    root(element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(query<HTMLSelectElement>(element, "[data-field='status']").value).toBe("closed");
  });

  it("cancels the draft on Escape", () => {
    const source = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    root(element).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(workflow.snapshot().status).toBe("cancelled");
    expect(statusText(element)).toMatch(/nothing was sent/i);
    expect(source.applyEdits).not.toHaveBeenCalled();
  });

  /**
   * The keyboard shortcuts live on the shadow root, which survives every
   * `innerHTML` re-render. Re-adding them per render would stack one handler
   * per render — invisible to assertions on workflow *state*, because the
   * surplus `undo()` / `cancel()` calls are no-ops, so these tests count
   * invocations instead.
   */
  function countCalls(
    workflow: HonuaFeatureEditorWorkflow<PermitAttributes>,
    method: "undo" | "redo" | "cancel",
  ): () => number {
    let calls = 0;
    const original = workflow[method].bind(workflow);
    // Shadows the prototype method for this instance only.
    (workflow as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      calls += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    return () => calls;
  }

  it("binds the keydown listener once, no matter how many times it re-renders", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.setSelection(feature());
    workflow.begin("update");

    // Every one of these notifies the element and forces a full re-render.
    setControl(element, "status", "closed");
    setControl(element, "priority", "4");
    setControl(element, "permit_no", "P-2");
    workflow.startSketch("point");
    expect(root(element).querySelector("[data-field='status']")).not.toBeNull();

    const undoCalls = countCalls(workflow, "undo");
    root(element).dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(undoCalls()).toBe(1);

    const redoCalls = countCalls(workflow, "redo");
    root(element).dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(redoCalls()).toBe(1);

    const cancelCalls = countCalls(workflow, "cancel");
    root(element).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(cancelCalls()).toBe(1);
  });

  it("releases the keydown listener on disconnect and re-arms exactly one on reconnect", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.setSelection(feature());
    workflow.begin("update");
    setControl(element, "status", "closed");

    const shadow = root(element);
    const undoCalls = countCalls(workflow, "undo");

    element.remove();
    // The shadow root outlives detachment; a listener left on it would still fire.
    shadow.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(undoCalls()).toBe(0);

    document.body.append(element);
    shadow.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(undoCalls()).toBe(1);

    // Repeated cycles must not accumulate handlers either.
    for (let i = 0; i < 3; i += 1) {
      element.remove();
      document.body.append(element);
    }
    shadow.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(undoCalls()).toBe(2);
  });

  it("routes shortcuts to the current workflow after the workflow is replaced", () => {
    const first = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const second = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(first);
    first.setSelection(feature());
    first.begin("update");

    element.workflow = second;
    second.setSelection(feature());
    second.begin("update");
    setControl(element, "status", "closed");

    const firstUndo = countCalls(first, "undo");
    const secondUndo = countCalls(second, "undo");
    root(element).dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(secondUndo()).toBe(1);
    expect(firstUndo()).toBe(0);
  });
});

describe("<honua-feature-editor> realtime, conflict, and commit states", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("preserves focus, caret, and unsaved values across an unrelated realtime change", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.setSelection(feature());
    workflow.begin("update");

    const permit = query<HTMLInputElement>(element, "[data-field='permit_no']");
    permit.value = "P-1-edited";
    permit.dispatchEvent(new Event("change", { bubbles: true }));
    const refreshed = query<HTMLInputElement>(element, "[data-field='permit_no']");
    refreshed.focus();
    refreshed.setSelectionRange(3, 3);

    expect(workflow.applyExternalChange({ id: 987, attributes: { OBJECTID: 987, status: "review" } })).toBe("ignored");
    const after = query<HTMLInputElement>(element, "[data-field='permit_no']");
    expect(after.value).toBe("P-1-edited");
    expect(root(element).activeElement).toBe(after);
    expect(after.selectionStart).toBe(3);
  });

  it("keeps focus and the caret when a reconciling change forces a re-render", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.setSelection(feature());
    workflow.begin("update");

    const permit = query<HTMLInputElement>(element, "[data-field='permit_no']");
    permit.value = "P-1-edited";
    permit.dispatchEvent(new Event("change", { bubbles: true }));
    query<HTMLInputElement>(element, "[data-field='permit_no']").focus();
    query<HTMLInputElement>(element, "[data-field='permit_no']").setSelectionRange(2, 5);

    expect(
      workflow.applyExternalChange({
        id: 1,
        attributes: { OBJECTID: 1, permit_no: "P-1", priority: 5, status: "open", version: 7 },
      }),
    ).toBe("reconciled");

    const after = query<HTMLInputElement>(element, "[data-field='permit_no']");
    expect(after.value).toBe("P-1-edited");
    expect(query<HTMLInputElement>(element, "[data-field='priority']").value).toBe("5");
    expect(root(element).activeElement?.getAttribute("data-field")).toBe("permit_no");
    expect(after.selectionStart).toBe(2);
    expect(after.selectionEnd).toBe(5);
  });

  it("renders a conflict panel with explicit resolutions and blocks submit until one is chosen", async () => {
    let attempt = 0;
    const source = makeSource({
      applyEdits: async () => {
        attempt += 1;
        return attempt === 1
          ? ok([], [{ id: 1, success: false, error: { code: 409, description: "row version 7 is stale" } }])
          : ok([], [{ id: 1, success: true }]);
      },
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.setSelection(feature());
    workflow.begin("update");
    setControl(element, "status", "closed");

    await workflow.submit();
    const panel = query(element, "[data-conflict-panel]");
    expect(panel.getAttribute("role")).toBe("group");
    expect(query(element, "[data-conflict-reason]").getAttribute("role")).toBe("alert");
    expect(
      [...root(element).querySelectorAll("[data-conflict]")].map((node) => node.getAttribute("data-conflict")),
    ).toEqual(["keep-mine", "discard-mine", "reload"]);
    expect(query<HTMLButtonElement>(element, "[data-action='submit']").disabled).toBe(true);

    query<HTMLButtonElement>(element, "[data-conflict='keep-mine']").click();
    expect(root(element).querySelector("[data-conflict-panel]")).toBeNull();
    expect(query<HTMLButtonElement>(element, "[data-action='submit']").disabled).toBe(false);
  });

  it("emits change and commit events, and never a payload, and never success for a rejection", async () => {
    const source = makeSource({
      applyEdits: async () => ok([{ success: false, error: { code: 403, description: "not permitted" } }]),
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    const element = mount(workflow);
    const changes: unknown[] = [];
    const commits: HonuaFeatureEditCommitDetail[] = [];
    element.addEventListener("honua-feature-edit-change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    element.addEventListener("honua-feature-edit-commit", (event) => {
      commits.push((event as CustomEvent<HonuaFeatureEditCommitDetail>).detail);
    });

    workflow.begin("create");
    setControl(element, "permit_no", "P-9");
    setControl(element, "status", "open");
    setControl(element, "priority", "2");
    expect(changes.length).toBeGreaterThan(0);

    query<HTMLButtonElement>(element, "[data-action='submit']").click();
    await vi.waitUntil(() => commits.length > 0);
    expect(commits[0]?.commit).toMatchObject({ status: "rejected", transported: true });
    expect(commits[0]?.commit.committedFeatureId).toBeUndefined();
    expect(root(element).querySelector("[data-failures]")?.getAttribute("role")).toBe("alert");
    expect(root(element).querySelector("[data-failures]")?.textContent).toContain("not permitted");
    expect(query<HTMLButtonElement>(element, "[data-action='retry']").disabled).toBe(false);
  });

  it("reports a committed edit in the live status region", async () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    setControl(element, "permit_no", "P-9");
    setControl(element, "status", "open");
    setControl(element, "priority", "2");

    const commit = await workflow.submit();
    expect(commit.status).toBe("committed");
    const status = query(element, "[data-status]");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toMatch(/Feature created \(id 101\)/);
  });

  it("resumes updating after being detached and reinserted", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    const changes: unknown[] = [];
    element.addEventListener("honua-feature-edit-change", (event) => {
      changes.push((event as CustomEvent).detail);
    });

    element.remove();
    workflow.setValue("permit_no", "P-WHILE-DETACHED");
    expect(changes).toHaveLength(0);

    document.body.append(element);
    // The element re-reads state on connect, so the change it missed is visible.
    expect(query<HTMLInputElement>(element, "[data-field='permit_no']").value).toBe("P-WHILE-DETACHED");

    workflow.setValue("permit_no", "P-AFTER-REINSERT");
    expect(query<HTMLInputElement>(element, "[data-field='permit_no']").value).toBe("P-AFTER-REINSERT");
    expect(changes).toHaveLength(1);
  });

  it("does not double-subscribe across repeated detach/reinsert cycles", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    const changes: unknown[] = [];
    element.addEventListener("honua-feature-edit-change", (event) => {
      changes.push((event as CustomEvent).detail);
    });

    for (let i = 0; i < 3; i += 1) {
      element.remove();
      document.body.append(element);
    }
    workflow.setValue("permit_no", "P-ONCE");
    // One workflow notification must produce exactly one change event.
    expect(changes).toHaveLength(1);
  });

  it("subscribes when a workflow assigned before insertion is connected", () => {
    defineHonuaWebComponents();
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = document.createElement("honua-feature-editor") as HonuaFeatureEditorElement<PermitAttributes>;
    element.workflow = workflow;
    workflow.begin("create");
    document.body.append(element);

    expect(root(element).querySelector("[data-field='permit_no']")).not.toBeNull();
    workflow.setValue("permit_no", "P-LATE-MOUNT");
    expect(query<HTMLInputElement>(element, "[data-field='permit_no']").value).toBe("P-LATE-MOUNT");
  });

  it("stops rendering once detached", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    workflow.begin("create");
    const before = root(element).innerHTML;
    element.remove();
    workflow.setValue("permit_no", "P-changed");
    expect(root(element).innerHTML).toBe(before);
  });

  it("detaches from a replaced workflow", () => {
    const first = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const second = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(first);
    element.workflow = second;
    expect(element.workflow).toBe(second);
    first.begin("create");
    expect(root(element).querySelector("[data-field]")).toBeNull();
    second.begin("create");
    expect(root(element).querySelector("[data-field='permit_no']")).not.toBeNull();
  });

  it("forwards the host's selection to the workflow", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource(), subtypes: SUBTYPES });
    const element = mount(workflow);
    expect(query<HTMLButtonElement>(element, "[data-operation='update']").disabled).toBe(true);
    element.selectedFeature = feature();
    expect(element.selectedFeature?.id).toBe(1);
    expect(query<HTMLButtonElement>(element, "[data-operation='update']").disabled).toBe(false);
  });
});
