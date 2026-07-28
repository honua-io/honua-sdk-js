// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import "../src/web-components/index.js";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) element.remove();
});

function mount(tagName: string, label: string): HTMLElement {
  const element = document.createElement(tagName);
  element.setAttribute("label", label);
  document.body.append(element);
  mounted.push(element);
  return element;
}

function shadow(element: HTMLElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe("web-component accessibility semantics", () => {
  it("gives the map a named region and named zoom controls", () => {
    const root = shadow(mount("honua-map", "Reference map"));
    expect(root.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("Reference map");
    expect(root.querySelector('button[aria-label="Zoom out"]')).not.toBeNull();
    expect(root.querySelector('button[aria-label="Zoom in"]')).not.toBeNull();
  });

  it("gives the editor a named panel and named native actions", () => {
    const root = shadow(mount("honua-editor", "Edit features"));
    expect(root.querySelector(".editor")?.getAttribute("aria-label")).toBe("Edit features");
    expect([...root.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual([
      "New",
      "Save",
      "Delete",
    ]);
  });

  it("gives the chart a named panel and heading", () => {
    const root = shadow(mount("honua-chart", "Incident counts"));
    expect(root.querySelector(".chart")?.getAttribute("aria-label")).toBe("Incident counts");
    expect(root.querySelector("h2")?.textContent).toBe("Incident counts");
  });

  it("gives basemap, bookmark, locate, status, and action controls named panels", () => {
    const controls = [
      ["honua-basemap-control", "Basemap choices"],
      ["honua-bookmarks", "Saved views"],
      ["honua-locate-control", "Find me"],
      ["honua-map-status", "Map information"],
      ["honua-action-panel", "Map actions"],
    ] as const;

    for (const [tagName, label] of controls) {
      const root = shadow(mount(tagName, label));
      expect(root.querySelector("section")?.getAttribute("aria-label")).toBe(label);
    }
  });

  it("exposes status messages and actionable controls with native semantics", () => {
    const locate = shadow(mount("honua-locate-control", "Locate"));
    expect(locate.querySelector("button[data-locate")?.textContent?.trim()).toBe("Use location");
    expect(locate.querySelector('[role="status"]')).not.toBeNull();

    const status = shadow(mount("honua-map-status", "Status"));
    expect(status.querySelector('span[aria-label="Approximate scale"]')).not.toBeNull();
    expect(status.querySelector('span[aria-label="Attribution"]')).not.toBeNull();
    expect(status.querySelector("button[data-fullscreen")?.textContent?.trim()).toBe("Fullscreen");

    const actions = shadow(mount("honua-action-panel", "Actions"));
    expect(actions.querySelector('[role="status"]')?.textContent).toContain("No actions");
  });
});
