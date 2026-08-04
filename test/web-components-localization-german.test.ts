// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  type HonuaFeatureTableElement,
  createHonuaWebComponentController,
  defineHonuaWebComponents,
} from "../src/web-components/index.js";

function shadow(element: Element): ShadowRoot {
  if (!element.shadowRoot) throw new Error("missing shadow root");
  return element.shadowRoot;
}

describe("web-component caller messages (German rendering)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    defineHonuaWebComponents();
  });

  it("localizes layer list, legend, and feature table labels and statuses", async () => {
    const controller = createHonuaWebComponentController({
      layers: [{ id: "roads", title: "Straßen", visible: true, opacity: 0.8 }],
    });
    const layers = document.createElement("honua-layer-list") as HonuaElementWithMessages;
    layers.controller = controller;
    layers.messages = {
      label: "Ebenen",
      opacityLabel: "Deckkraft",
      opacityValue: (percent: number) => `${percent} Prozent`,
      moveUpLabel: "Nach oben",
      moveDownLabel: "Nach unten",
    };
    document.body.append(layers);
    expect(shadow(layers).querySelector("legend")?.textContent).toBe("Ebenen");
    expect(shadow(layers).querySelector("input[data-layer-opacity]")?.getAttribute("aria-valuetext")).toBe(
      "80 Prozent",
    );

    const legend = document.createElement("honua-legend") as HonuaElementWithMessages;
    legend.messages = { label: "Legende", noLegend: "Keine Legende" };
    document.body.append(legend);
    expect(shadow(legend).querySelector("section")?.getAttribute("aria-label")).toBe("Legende");
    expect(shadow(legend).querySelector(".empty")?.textContent).toBe("Keine Legende");

    const table = document.createElement("honua-feature-table") as HonuaFeatureTableElement;
    table.messages = {
      label: "Objekte",
      count: (count) => (count.kind === "known" ? `${count.value} Datensätze` : "Unbekannte Anzahl"),
      status: { idle: "Nicht geladen", loading: "Lade Datensätze" },
    };
    document.body.append(table);
    expect(shadow(table).querySelector("h2")?.textContent).toBe("Objekte");
  });

  it("localizes search, feature editor, chart, basemap, measurement, and map status", () => {
    const search = document.createElement("honua-search") as HonuaElementWithMessages;
    search.messages = {
      label: "Suche",
      placeholder: "Adresse suchen",
      submitLabel: "Suchen",
      suggestionsLabel: "Vorschläge",
    };
    document.body.append(search);
    expect(shadow(search).querySelector("section")?.getAttribute("aria-label")).toBe("Suche");
    expect(shadow(search).querySelector("input")?.getAttribute("placeholder")).toBe("Adresse suchen");
    expect(shadow(search).querySelector("button")?.textContent).toBe("Suchen");

    const editor = document.createElement("honua-feature-editor") as HonuaElementWithMessages;
    editor.messages = { label: "Feature-Editor", noWorkflow: "Kein Bearbeitungsworkflow verbunden." };
    document.body.append(editor);
    expect(shadow(editor).querySelector("h2")?.textContent).toBe("Feature-Editor");
    expect(shadow(editor).querySelector(".empty")?.textContent).toBe("Kein Bearbeitungsworkflow verbunden.");

    const chart = document.createElement("honua-chart") as HonuaElementWithMessages;
    chart.messages = { label: "Diagramm", noData: "Keine Diagrammdaten" };
    document.body.append(chart);
    expect(shadow(chart).querySelector("h2")?.textContent).toBe("Diagramm");
    expect(shadow(chart).querySelector(".empty")?.textContent).toBe("Keine Diagrammdaten");

    const basemap = document.createElement("honua-basemap-control") as HonuaElementWithMessages;
    basemap.messages = { label: "Hintergrundkarten", unavailable: "Mindestens zwei Karten erforderlich." };
    document.body.append(basemap);
    expect(shadow(basemap).querySelector("h2")?.textContent).toBe("Hintergrundkarten");

    const measurement = document.createElement("honua-measurement") as unknown as HonuaElementWithMessages;
    measurement.messages = { label: "Messen", waitingForMap: "Warte auf Karte", offStatus: "Messung deaktiviert" };
    document.body.append(measurement);
    expect(shadow(measurement).querySelector("h2")?.textContent).toBe("Messen");
    expect(shadow(measurement).querySelector(".value")?.textContent).toBe("Messung deaktiviert");

    const timeSlider = document.createElement("honua-time-slider") as HonuaElementWithMessages;
    timeSlider.messages = {
      label: "Zeitachse",
      play: "Abspielen",
      stepBackward: "Ein Fenster zurück",
      stepForward: "Ein Fenster vor",
      speedLabel: "Geschwindigkeit",
      speedOption: (multiplier: number) => `${multiplier}-fach`,
      transportGroupLabel: (label: string) => `${label} Wiedergabe`,
      noPlayback: "Keine Zeitsteuerung verbunden",
      hint: "Pfeiltasten verschieben das Zeitfenster.",
    };
    document.body.append(timeSlider);
    expect(shadow(timeSlider).querySelector("h2")?.textContent).toBe("Zeitachse");
    expect(shadow(timeSlider).querySelector(".window")?.textContent).toBe("Keine Zeitsteuerung verbunden");
    expect(shadow(timeSlider).querySelector("[data-time-toggle]")?.textContent).toBe("Abspielen");
    expect(shadow(timeSlider).querySelector("[data-time-step='-1']")?.textContent).toBe("Ein Fenster zurück");
    expect(shadow(timeSlider).querySelector("[role='group']")?.getAttribute("aria-label")).toBe("Zeitachse Wiedergabe");
    expect(shadow(timeSlider).querySelector(".hint")?.textContent).toBe("Pfeiltasten verschieben das Zeitfenster.");

    const status = document.createElement("honua-map-status") as HonuaElementWithMessages;
    status.messages = {
      label: "Kartenstatus",
      scaleLabel: "Ungefährer Maßstab",
      attributionLabel: "Quelle",
      fullscreenLabel: "Vollbild",
    };
    document.body.append(status);
    expect(shadow(status).querySelector("section")?.getAttribute("aria-label")).toBe("Kartenstatus");
    expect(shadow(status).querySelector("button")?.textContent).toBe("Vollbild");
    expect(shadow(status).querySelector("span")?.getAttribute("aria-label")).toBe("Ungefährer Maßstab");
  });
});

type HonuaElementWithMessages = HTMLElement & {
  controller?: any;
  messages: any;
};
