import { afterEach, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import type { CatalogCardProjection } from "../src/catalog-components/presentation.js";
import { catalogClientFixture, mountCatalogFixture } from "./fixtures/catalog-components/elements.js";
import { relationPage, releasedApp } from "./fixtures/catalog-components/relations.js";

afterEach(() => document.body.replaceChildren());

it("normalizes endpoint display, clipboard and copy events without repeating ready state", async () => {
  const endpoint = { protocol: "wms", href: "HTTPS://CATALOG.EXAMPLE:443/wms?SERVICE=WMS", mediaType: null };
  const client = catalogClientFixture({ ...releasedApp, id: "roads", kind: "service", endpoints: [endpoint] });
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const element = mountCatalogFixture("honua-service-endpoints", client, (element) => {
    element.setAttribute("service", "roads");
    element.setAttribute("copy", "");
  });
  const copied = vi.fn();
  const states = vi.fn();
  element.addEventListener("honua-endpoint-copy", copied);
  element.addEventListener("honua-catalog-state-change", states);
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("a")).not.toBeNull());
  expect(element.shadowRoot?.querySelector("a")?.textContent).toBe("https://catalog.example/wms?SERVICE=WMS");
  states.mockClear();
  (element.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(copied).toHaveBeenCalledTimes(1));
  expect(writeText).toHaveBeenCalledWith("https://catalog.example/wms?SERVICE=WMS");
  expect((copied.mock.calls[0][0] as CustomEvent).detail.href).toBe("https://catalog.example/wms?SERVICE=WMS");
  expect(states).not.toHaveBeenCalled();
});

it("groups endpoints only when requested and names each copy control distinctly", async () => {
  const client = catalogClientFixture({
    ...releasedApp,
    id: "roads",
    kind: "service",
    endpoints: [
      { protocol: "wms", href: "https://catalog.example/wms", mediaType: "text/xml" },
      { protocol: "wms", href: "https://catalog.example/maps", mediaType: "image/png" },
    ],
  });
  const element = mountCatalogFixture("honua-service-endpoints", client, (element) => {
    element.setAttribute("service", "roads");
    element.setAttribute("copy", "");
  });
  await vi.waitFor(() => expect(element.shadowRoot?.querySelectorAll("a")).toHaveLength(2));
  expect(element.shadowRoot?.querySelectorAll("section")).toHaveLength(0);
  const names = [...element.shadowRoot!.querySelectorAll("button")].map((button) => button.textContent);
  expect(new Set(names).size).toBe(2);
  element.setAttribute("group", "protocol");
  await vi.waitFor(() => expect(element.shadowRoot?.querySelectorAll("section")).toHaveLength(1));
  expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("wms endpoints");
});

it("reports filtered endpoints honestly", async () => {
  const client = catalogClientFixture({
    ...releasedApp,
    id: "roads",
    kind: "service",
    endpoints: [{ protocol: "wms", href: "https://catalog.example/wms", mediaType: null }],
  });
  const element = mountCatalogFixture("honua-service-endpoints", client, (element) => {
    element.setAttribute("service", "roads");
    element.setAttribute("protocols", "wfs");
  });
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("No matching safe endpoints"));
});

it.each(["group", "view"])("rejects unsupported %s configuration before reading", async (attribute) => {
  const client = { ...catalogClientFixture(), listCatalogAppsUsing: vi.fn(async () => relationPage) };
  const tag = attribute === "group" ? "honua-service-endpoints" : "honua-apps-using";
  const element = mountCatalogFixture(tag, client, (element) => {
    element.setAttribute("service", "roads");
    element.setAttribute(attribute, "unsupported");
  });
  expect(element.shadowRoot?.textContent).toMatch(/Configure|grouping/);
  expect(client.getCatalogItem).not.toHaveBeenCalled();
  expect(client.listCatalogAppsUsing).not.toHaveBeenCalled();
});

it("ignores late clipboard completion after client revocation", async () => {
  let complete!: () => void;
  const writeText = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const client = catalogClientFixture({
    ...releasedApp,
    id: "roads",
    kind: "service",
    endpoints: [{ protocol: "wms", href: "https://catalog.example/wms", mediaType: null }],
  });
  const element = mountCatalogFixture("honua-service-endpoints", client, (element) => {
    element.setAttribute("service", "roads");
    element.setAttribute("copy", "");
  });
  const copied = vi.fn();
  element.addEventListener("honua-endpoint-copy", copied);
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("button")).not.toBeNull());
  (element.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
  element.client = undefined;
  complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(copied).not.toHaveBeenCalled();
  expect(element.shadowRoot?.textContent).toContain("not configured");
});

it("aborts endpoint reads on identity change and rejects mismatched results with metadata", async () => {
  let resolve!: (value: CatalogCardProjection) => void;
  let oldSignal!: AbortSignal;
  const client = catalogClientFixture();
  client.getCatalogItem = vi.fn((_identity, options) => {
    oldSignal = options!.signal!;
    return new Promise<CatalogCardProjection>((accept) => {
      resolve = accept;
    });
  });
  const element = mountCatalogFixture("honua-service-endpoints", client, (element) =>
    element.setAttribute("service", "roads"),
  );
  const staleSignal = oldSignal;
  const staleResolve = resolve;
  element.setAttribute("service", "new");
  expect(staleSignal.aborted).toBe(true);
  staleResolve({ ...releasedApp, title: "Stale endpoint" });
  resolve({ ...releasedApp, structuredData: relationPage.structuredData });
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
  expect(element.shadowRoot?.querySelector("a")).toBeNull();
  expect(document.querySelector("script[type='application/ld+json']")).toBeNull();
});
