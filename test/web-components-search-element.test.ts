// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HonuaGeocodeSelectDetail,
  HonuaSearchElement,
  HonuaSearchGeocoderLike,
  HonuaWebComponentController,
} from "../src/web-components/index.js";
import { createHonuaWebComponentController, defineHonuaWebComponents } from "../src/web-components/index.js";

/**
 * Survival-tier `<honua-search>` (issue #493): debounced geocoder typeahead,
 * ARIA combobox keyboard interaction, and viewport pan/zoom on selection.
 */

const CANDIDATE = { address: "Honolulu Harbor, HI", latitude: 21.306, longitude: -157.867, score: 100 };

function makeGeocoder() {
  return {
    suggest: vi.fn(async (text: string) => [{ text: `${text} Harbor` }, { text: `${text} Airport` }]),
    forwardGeocode: vi.fn(async () => [CANDIDATE]),
  } satisfies HonuaSearchGeocoderLike;
}

function mountSearch(controller: HonuaWebComponentController, geocoder: HonuaSearchGeocoderLike): HonuaSearchElement {
  defineHonuaWebComponents();
  const element = document.createElement("honua-search") as HonuaSearchElement;
  element.setAttribute("zoom", "14");
  document.body.append(element);
  element.controller = controller;
  element.geocoder = geocoder;
  return element;
}

function input(element: HonuaSearchElement): HTMLInputElement {
  const field = element.shadowRoot?.querySelector<HTMLInputElement>("input[name='q']");
  if (!field) throw new Error("missing search input");
  return field;
}

function type(element: HonuaSearchElement, text: string): void {
  const field = input(element);
  field.value = text;
  field.dispatchEvent(new Event("input"));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("<honua-search> (survival tier, geocoding lane)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the ARIA combobox contract when a geocoder is assigned", () => {
    const element = mountSearch(createHonuaWebComponentController(), makeGeocoder());
    const field = input(element);
    expect(field.getAttribute("role")).toBe("combobox");
    expect(field.getAttribute("aria-autocomplete")).toBe("list");
    expect(field.getAttribute("aria-expanded")).toBe("false");
    expect(field.getAttribute("aria-controls")).toBe("honua-search-listbox");
    expect(element.shadowRoot?.querySelector("[role='listbox']")).not.toBeNull();
  });

  it("keeps the plain textbox contract when no geocoder is assigned", () => {
    defineHonuaWebComponents();
    const element = document.createElement("honua-search") as HonuaSearchElement;
    document.body.append(element);
    const field = input(element);
    expect(field.getAttribute("role")).toBeNull();
    expect(element.shadowRoot?.querySelector("[role='listbox']")).toBeNull();
  });

  it("debounces suggest calls and renders options", async () => {
    const geocoder = makeGeocoder();
    const element = mountSearch(createHonuaWebComponentController(), geocoder);

    type(element, "hon");
    type(element, "hono");
    type(element, "honol");
    expect(geocoder.suggest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(geocoder.suggest).toHaveBeenCalledTimes(1);
    expect(geocoder.suggest).toHaveBeenCalledWith("honol", { maxSuggestions: 8 });
    const options = element.shadowRoot?.querySelectorAll("[role='option']");
    expect(options).toHaveLength(2);
    expect(input(element).getAttribute("aria-expanded")).toBe("true");
    // The typed value survives the suggestion re-render.
    expect(input(element).value).toBe("honol");
  });

  it("navigates suggestions with arrow keys, selects with Enter, and pans/zooms the map", async () => {
    const geocoder = makeGeocoder();
    const controller = createHonuaWebComponentController();
    const element = mountSearch(controller, geocoder);
    const selections: HonuaGeocodeSelectDetail[] = [];
    element.addEventListener("honua-geocode-select", (event) => {
      selections.push((event as CustomEvent<HonuaGeocodeSelectDetail>).detail);
    });

    type(element, "honolulu");
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    input(element).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    let field = input(element);
    expect(field.getAttribute("aria-activedescendant")).toBe("honua-search-option-0");
    expect(element.shadowRoot?.querySelector("#honua-search-option-0")?.getAttribute("aria-selected")).toBe("true");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    field = input(element);
    expect(field.getAttribute("aria-activedescendant")).toBe("honua-search-option-1");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flushMicrotasks();

    expect(geocoder.forwardGeocode).toHaveBeenCalledWith("honolulu Airport", { maxResults: 1 });
    expect(controller.getState().viewport).toMatchObject({
      center: [CANDIDATE.longitude, CANDIDATE.latitude],
      zoom: 14,
    });
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({
      query: "honolulu Airport",
      candidate: CANDIDATE,
      viewport: { center: [CANDIDATE.longitude, CANDIDATE.latitude], zoom: 14 },
    });
    // The listbox closes after selection and announces the match.
    expect(input(element).getAttribute("aria-expanded")).toBe("false");
    expect(element.shadowRoot?.querySelector("[role='status']")?.textContent).toContain(CANDIDATE.address);
  });

  it("dismisses suggestions with Escape", async () => {
    const element = mountSearch(createHonuaWebComponentController(), makeGeocoder());
    type(element, "hono");
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();
    expect(element.shadowRoot?.querySelectorAll("[role='option']")).toHaveLength(2);

    input(element).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(element.shadowRoot?.querySelectorAll("[role='option']")).toHaveLength(0);
    expect(input(element).getAttribute("aria-expanded")).toBe("false");
  });

  it("geocodes on submit and reports empty results in the status region", async () => {
    const geocoder = {
      forwardGeocode: vi.fn(async () => []),
    } satisfies HonuaSearchGeocoderLike;
    const element = mountSearch(createHonuaWebComponentController(), geocoder);

    input(element).value = "nowhere";
    element.shadowRoot?.querySelector("form")?.dispatchEvent(new Event("submit"));
    await flushMicrotasks();

    expect(geocoder.forwardGeocode).toHaveBeenCalledWith("nowhere", { maxResults: 1 });
    expect(element.shadowRoot?.querySelector("[role='status']")?.textContent).toContain('No results for "nowhere"');
  });

  it("selects a suggestion by click", async () => {
    const geocoder = makeGeocoder();
    const controller = createHonuaWebComponentController();
    const element = mountSearch(controller, geocoder);

    type(element, "hono");
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    const option = element.shadowRoot?.querySelector<HTMLElement>("#honua-search-option-0");
    option?.click();
    await flushMicrotasks();

    expect(geocoder.forwardGeocode).toHaveBeenCalledWith("hono Harbor", { maxResults: 1 });
    expect(controller.getState().viewport.center).toEqual([CANDIDATE.longitude, CANDIDATE.latitude]);
  });
});
