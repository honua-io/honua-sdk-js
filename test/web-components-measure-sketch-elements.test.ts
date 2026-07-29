import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  HonuaMeasureChangeDetail,
  HonuaMeasureControlMessages,
  HonuaMeasureMode,
  HonuaMeasureProvider,
  HonuaSketchChangeDetail,
  HonuaSketchControlMessages,
  HonuaSketchMode,
  HonuaSketchProvider,
} from "../src/web-components/index.js";

/**
 * The unit-test environment has no DOM. These tests install a deliberately tiny
 * DOM shim that implements only what the measure/sketch elements touch
 * (`attachShadow`, an `innerHTML`-backed shadow root, `querySelectorAll`,
 * attribute access, and `CustomEvent` dispatch) so we can assert the rendered
 * enabled/disabled affordance and the emitted change-event geometry without
 * pulling in jsdom/happy-dom as a dependency.
 */

interface FakeButton {
  readonly dataset: Record<string, string>;
  disabled: boolean;
  ariaDisabled: boolean;
  readonly handlers: Array<() => void>;
  addEventListener(type: string, handler: () => void): void;
  click(): void;
}

class FakeShadowRoot {
  #html = "";
  #buttons: FakeButton[] = [];

  public get innerHTML(): string {
    return this.#html;
  }

  public set innerHTML(value: string) {
    this.#html = value;
    this.#buttons = parseButtons(value);
  }

  public querySelectorAll(selector: string): FakeButton[] {
    const attr = selector.includes("data-measure-mode") ? "measureMode" : "sketchMode";
    return this.#buttons.filter((button) => attr in button.dataset);
  }

  public querySelector(): null {
    return null;
  }
}

function parseButtons(html: string): FakeButton[] {
  const buttons: FakeButton[] = [];
  const re = /<button\b([^>]*)>/g;
  let match: RegExpExecArray | null = re.exec(html);
  while (match !== null) {
    const tag = match[1] ?? "";
    const dataset: Record<string, string> = {};
    const measure = /data-measure-mode="([^"]*)"/.exec(tag);
    const sketch = /data-sketch-mode="([^"]*)"/.exec(tag);
    if (measure) dataset.measureMode = measure[1] ?? "";
    if (sketch) dataset.sketchMode = sketch[1] ?? "";
    const disabled = /\bdisabled\b/.test(tag);
    const ariaDisabled = /aria-disabled="true"/.test(tag);
    const handlers: Array<() => void> = [];
    buttons.push({
      dataset,
      disabled,
      ariaDisabled,
      handlers,
      addEventListener(_type, handler) {
        handlers.push(handler);
      },
      click() {
        for (const handler of handlers) handler();
      },
    });
    match = re.exec(html);
  }
  return buttons;
}

class FakeCustomEvent<D> {
  public readonly type: string;
  public readonly detail: D;
  public constructor(type: string, init: { detail: D }) {
    this.type = type;
    this.detail = init.detail;
  }
}

const originalHtmlElement = (globalThis as Record<string, unknown>).HTMLElement;
const originalCustomEvent = (globalThis as Record<string, unknown>).CustomEvent;

beforeEach(() => {
  class FakeHTMLElement {
    public shadowRoot: FakeShadowRoot | undefined;
    readonly #attributes = new Map<string, string>();
    public readonly events: Array<FakeCustomEvent<unknown>> = [];
    public attachShadow(): FakeShadowRoot {
      this.shadowRoot = new FakeShadowRoot();
      return this.shadowRoot;
    }
    public getAttribute(name: string): string | null {
      return this.#attributes.get(name) ?? null;
    }
    public setAttribute(name: string, value: string): void {
      this.#attributes.set(name, value);
    }
    public getRootNode(): undefined {
      return undefined;
    }
    public dispatchEvent(event: FakeCustomEvent<unknown>): boolean {
      this.events.push(event);
      return true;
    }
    public addEventListener(): void {}
    public removeEventListener(): void {}
  }
  (globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement;
  (globalThis as Record<string, unknown>).CustomEvent = FakeCustomEvent;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).HTMLElement = originalHtmlElement;
  (globalThis as Record<string, unknown>).CustomEvent = originalCustomEvent;
});

async function loadElements() {
  // Import after the globals are installed (see `installDom`) so the element
  // base class binds to the fake HTMLElement. The module is cached after the
  // first import; the fake DOM is functionally identical on every test.
  return await import("../src/web-components/elements.js");
}

interface ControllerStub {
  getState(): { status: string };
  subscribe(listener: (state: { status: string }) => void): { remove(): void };
  canMeasure(): boolean;
  canSketch(): boolean;
  setMeasureMode(mode: HonuaMeasureMode): Promise<HonuaMeasureChangeDetail>;
  setSketchMode(mode: HonuaSketchMode): Promise<HonuaSketchChangeDetail>;
}

const baseControllerStub = {
  getState: () => ({ status: "ready" }),
  subscribe: (listener: (state: { status: string }) => void) => {
    listener({ status: "ready" });
    return { remove() {} };
  },
};

const measureProvider: HonuaMeasureProvider = {
  startMode: (mode) =>
    mode === "off"
      ? undefined
      : {
          mode,
          coordinates: [
            [-157.87, 21.31],
            [-157.86, 21.29],
          ],
          distance: 2400,
        },
};

const sketchProvider: HonuaSketchProvider = {
  startMode: (mode) => (mode === "off" ? undefined : { mode, id: "drawn-1", geometry: { x: -157.86, y: 21.3 } }),
};

describe("measure and sketch control elements", () => {
  it("renders German measure status, actions, and empty-state text", async () => {
    const { HonuaMeasureControlElement } = await loadElements();
    const element = new HonuaMeasureControlElement() as unknown as {
      controller?: ControllerStub;
      messages: HonuaMeasureControlMessages;
      shadowRoot?: FakeShadowRoot;
      connectedCallback(): void;
    };
    element.messages = {
      status: { ready: "Bereit", unsupported: "Nicht verfügbar" },
      actionLabels: { off: "Beenden", distance: "Entfernung", area: "Fläche" },
      empty: "Messung ist deaktiviert.",
    };
    element.controller = { ...baseControllerStub, canMeasure: () => false } as unknown as ControllerStub;
    element.connectedCallback();

    let html = element.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Nicht verfügbar");
    expect(html).toContain("Messung ist deaktiviert.");
    expect(html).toContain("Beenden");
    expect(html).toContain("Entfernung");
    expect(html).toContain("Fläche");

    element.controller = {
      ...baseControllerStub,
      canMeasure: () => true,
      setMeasureMode: (mode: HonuaMeasureMode) => Promise.resolve({ mode, status: "ready" }),
    } as unknown as ControllerStub;
    element.connectedCallback();
    html = element.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Bereit");
    expect(html).toContain("Beenden");
  });

  it("renders measure modes disabled with a configure-a-provider affordance when none is supplied", async () => {
    const { HonuaMeasureControlElement } = await loadElements();
    const element = new HonuaMeasureControlElement() as unknown as {
      controller?: ControllerStub;
      shadowRoot?: FakeShadowRoot;
      connectedCallback(): void;
    };
    element.controller = { ...baseControllerStub, canMeasure: () => false } as unknown as ControllerStub;
    element.connectedCallback();

    const html = element.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("no geometry provider is configured");
    expect(html).toContain("measurementGeometry");
    const buttons = element.shadowRoot?.querySelectorAll("button[data-measure-mode]") ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled && button.ariaDisabled)).toBe(true);
  });

  it("enables measure modes and emits geometry on mode change when a provider is supplied", async () => {
    const { HonuaMeasureControlElement } = await loadElements();
    const controller = {
      ...baseControllerStub,
      canMeasure: () => true,
      canSketch: () => false,
      setMeasureMode: (mode: HonuaMeasureMode) =>
        Promise.resolve({ mode, status: "ready", result: measureProvider.startMode(mode) } as HonuaMeasureChangeDetail),
      setSketchMode: () => Promise.resolve({ mode: "off", status: "unsupported" } as HonuaSketchChangeDetail),
    } satisfies ControllerStub;
    const element = new HonuaMeasureControlElement() as unknown as {
      controller?: ControllerStub;
      shadowRoot?: FakeShadowRoot;
      events: Array<FakeCustomEvent<HonuaMeasureChangeDetail>>;
      connectedCallback(): void;
    };
    element.controller = controller;
    element.connectedCallback();

    const buttons = element.shadowRoot?.querySelectorAll("button[data-measure-mode]") ?? [];
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    const distance = buttons.find((button) => button.dataset.measureMode === "distance");
    expect(distance).toBeDefined();
    distance?.click();
    await Promise.resolve();
    await Promise.resolve();

    const change = element.events.at(-1);
    expect(change?.type).toBe("honua-measure-change");
    expect(change?.detail.status).toBe("ready");
    expect(change?.detail.result?.distance).toBe(2400);
  });

  it("enables sketch modes and emits geometry on mode change when a provider is supplied", async () => {
    const { HonuaSketchControlElement } = await loadElements();
    const controller = {
      ...baseControllerStub,
      canMeasure: () => false,
      canSketch: () => true,
      setMeasureMode: () => Promise.resolve({ mode: "off", status: "unsupported" } as HonuaMeasureChangeDetail),
      setSketchMode: (mode: HonuaSketchMode) =>
        Promise.resolve({ mode, status: "ready", result: sketchProvider.startMode(mode) } as HonuaSketchChangeDetail),
    } satisfies ControllerStub;
    const element = new HonuaSketchControlElement() as unknown as {
      controller?: ControllerStub;
      shadowRoot?: FakeShadowRoot;
      events: Array<FakeCustomEvent<HonuaSketchChangeDetail>>;
      connectedCallback(): void;
    };
    element.controller = controller;
    element.connectedCallback();

    const buttons = element.shadowRoot?.querySelectorAll("button[data-sketch-mode]") ?? [];
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    const point = buttons.find((button) => button.dataset.sketchMode === "point");
    point?.click();
    await Promise.resolve();
    await Promise.resolve();

    const change = element.events.at(-1);
    expect(change?.type).toBe("honua-sketch-change");
    expect(change?.detail.status).toBe("ready");
    expect(change?.detail.result?.id).toBe("drawn-1");
  });

  it("renders German sketch status, actions, and empty-state text", async () => {
    const { HonuaSketchControlElement } = await loadElements();
    const element = new HonuaSketchControlElement() as unknown as {
      controller?: ControllerStub;
      messages: HonuaSketchControlMessages;
      shadowRoot?: FakeShadowRoot;
      connectedCallback(): void;
    };
    element.messages = {
      status: { ready: "Bereit", unsupported: "Nicht verfügbar" },
      actionLabels: { off: "Beenden", point: "Punkt", line: "Linie", polygon: "Polygon" },
      empty: "Skizzieren ist deaktiviert.",
    };
    element.controller = { ...baseControllerStub, canSketch: () => false } as unknown as ControllerStub;
    element.connectedCallback();

    const html = element.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Nicht verfügbar");
    expect(html).toContain("Skizzieren ist deaktiviert.");
    expect(html).toContain("Punkt");
    expect(html).toContain("Linie");
    expect(html).toContain("Polygon");
  });
});
