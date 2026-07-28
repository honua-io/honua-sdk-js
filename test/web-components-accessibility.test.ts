// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

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
    const locateCss = locate.querySelector("style")?.textContent ?? "";
    expect(locateCss).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(locateCss).toContain("background: Canvas");
    expect(locateCss).toContain("border-color: ButtonText");

    const status = shadow(mount("honua-map-status", "Status"));
    expect(status.querySelector('span[aria-label="Approximate scale"]')).not.toBeNull();
    expect(status.querySelector('span[aria-label="Attribution"]')).not.toBeNull();
    expect(status.querySelector("button[data-fullscreen")?.textContent?.trim()).toBe("Fullscreen");

    const bookmarks = shadow(mount("honua-bookmarks", "Bookmarks"));
    const bookmarkCss = bookmarks.querySelector("style")?.textContent ?? "";
    expect(bookmarkCss).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(bookmarkCss).toContain("background: Canvas");
    expect(bookmarkCss).toContain("border-color: ButtonText");

    const actions = shadow(mount("honua-action-panel", "Actions"));
    expect(actions.querySelector('[role="status"]')?.textContent).toContain("No actions");

    for (const tagName of ["honua-measure-control", "honua-sketch-control"] as const) {
      const controlCss = shadow(mount(tagName, tagName)).querySelector("style")?.textContent ?? "";
      expect(controlCss).toContain("@media (forced-colors: active), (prefers-contrast: more)");
      expect(controlCss).toContain("background: Canvas");
      expect(controlCss).toContain("border-color: ButtonText");
    }

    const printCss = shadow(mount("honua-print-export", "Print/export")).querySelector("style")?.textContent ?? "";
    expect(printCss).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(printCss).toContain("background: Canvas");
    expect(printCss).toContain("border-color: ButtonText");
  });

  it("mounts and disconnects the covered controls without console errors", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const tagName of [
        "honua-map",
        "honua-editor",
        "honua-chart",
        "honua-basemap-control",
        "honua-bookmarks",
        "honua-locate-control",
        "honua-map-status",
        "honua-action-panel",
      ]) {
        mount(tagName, "Console-safe control");
      }
      for (const element of mounted.splice(0)) element.remove();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
