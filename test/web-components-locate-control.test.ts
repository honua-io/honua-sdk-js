// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { HonuaLocateControlElement } from "../src/web-components/index.js";

describe("<honua-locate-control> localization", () => {
  it("renders caller-supplied labels and messages for a configured location", () => {
    const element = new HonuaLocateControlElement();
    element.setAttribute("label", "Standort");
    element.setAttribute("latitude", "21.31");
    element.setAttribute("longitude", "-157.87");
    element.messages = {
      actionLabel: "Standort verwenden",
      status: { idle: "Bereit" },
      initial: "Die gemeinsame Kartenansicht wird zentriert.",
    };
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe("Standort");
    expect(element.shadowRoot?.querySelector("button[data-locate]")?.textContent).toBe("Standort verwenden");
    expect(element.shadowRoot?.querySelector(".control-panel__bar span")?.textContent).toBe("Bereit");
    expect(element.shadowRoot?.querySelector("p[role='status']")?.textContent).toBe(
      "Die gemeinsame Kartenansicht wird zentriert.",
    );
  });

  it("renders a localized unsupported state", () => {
    const element = new HonuaLocateControlElement();
    element.setAttribute("latitude", "not-a-coordinate");
    element.setAttribute("longitude", "not-a-coordinate");
    element.messages = {
      actionLabel: "Standort verwenden",
      status: { unsupported: "Nicht verfügbar" },
      unavailable: "Geolokalisierung ist nicht verfügbar.",
    };
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("button[data-locate]")?.hasAttribute("disabled")).toBe(true);
    expect(element.shadowRoot?.querySelector(".control-panel__bar span")?.textContent).toBe("Nicht verfügbar");
    expect(element.shadowRoot?.querySelector("p[role='status']")?.textContent).toBe(
      "Geolokalisierung ist nicht verfügbar.",
    );
  });
});
