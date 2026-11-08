// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCatalogComponents } from "../src/catalog-components/index.js";
import type { CatalogCardProjection } from "../src/catalog-components/presentation.js";

import {
  catalogCardFixture as card,
  mountCatalogFixture as mount,
  catalogClientFixture as source,
} from "./fixtures/catalog-components/elements.js";

afterEach(() => document.body.replaceChildren());

describe("catalog component fixture slice", () => {
  it("does not register anything until the flag is explicitly enabled", () => {
    const registry = { define: vi.fn(), get: vi.fn() };
    defineCatalogComponents({ registry });
    expect(registry.define).not.toHaveBeenCalled();
  });

  it("is idempotent and refuses a conflicting registry owner", () => {
    defineCatalogComponents({ enabled: true });
    const elementClass = customElements.get("honua-service-card");
    defineCatalogComponents({ enabled: true });
    expect(customElements.get("honua-service-card")).toBe(elementClass);
    const registry = { get: () => class extends HTMLElement {}, define: vi.fn() };
    expect(() => defineCatalogComponents({ enabled: true, registry })).toThrow("Conflicting catalog element");
  });

  it("renders permitted text, meaningful thumbnails and health words without inline markup", async () => {
    const element = mount("honua-dataset-card", source({ ...card, title: "<img onerror=alert(1)>" }));
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("h2")?.textContent).toContain("<img"));
    expect(element.shadowRoot?.querySelector("h2 img")).toBeNull();
    expect(element.shadowRoot?.querySelector("img")?.alt).toBe(card.thumbnail?.alt);
    expect(element.shadowRoot?.textContent).toContain("Degraded");
    expect(element.shadowRoot?.querySelector("style, [style], script")).toBeNull();
    expect(element.shadowRoot?.querySelector('link[rel="stylesheet"]')).not.toBeNull();
  });

  it.each(["layer", "service", "map", "app"])("registers the %s card without claiming honua-map", async (kind) => {
    const element = mount(`honua-${kind}-card`, source({ ...card, kind, releasedVersionId: "v1" }));
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Flood zones"));
    expect(customElements.get("honua-map")).toBeUndefined();
  });

  it("clears a protected projection synchronously when the visitor client changes", async () => {
    const element = mount("honua-dataset-card");
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Flood zones"));
    const client = source();
    vi.mocked(client.getCatalogItem).mockRejectedValue({ status: 403 });
    element.client = client;
    expect(element.shadowRoot?.textContent).not.toContain("Flood zones");
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
    expect(element.shadowRoot?.querySelector("img")).toBeNull();
  });

  it("rejects unsafe and credential-bearing URLs and unreleased maps", async () => {
    const element = mount("honua-map-card", source({ ...card, kind: "map", detailHref: "javascript:alert(1)" }));
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
    expect(element.shadowRoot?.querySelector("a, img")).toBeNull();
    const unsafe = mount(
      "honua-dataset-card",
      source({ ...card, detailHref: "https://catalog.example/?token=secret" }),
    );
    await vi.waitFor(() => expect(unsafe.shadowRoot?.textContent).toContain("unavailable"));
    expect(unsafe.shadowRoot?.querySelector("a")).toBeNull();
  });

  it("requires catalog and identity instead of making an unbounded request", async () => {
    const client = source();
    const element = mount("honua-service-card", client);
    element.removeAttribute("catalog");
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Configure"));
    vi.mocked(client.getCatalogItem).mockClear();
    element.setAttribute("show", "health");
    expect(client.getCatalogItem).not.toHaveBeenCalled();
  });

  it("ignores an old read after identity replacement and aborts on disconnect", async () => {
    const client = source();
    let finish!: (item: CatalogCardProjection) => void;
    vi.mocked(client.getCatalogItem)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...card, id: "new" });
    const element = mount("honua-dataset-card", client);
    element.setAttribute("dataset", "new");
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Flood zones"));
    finish({ ...card, title: "Old secret" });
    await Promise.resolve();
    expect(element.shadowRoot?.textContent).not.toContain("Old secret");
    const signal = vi.mocked(client.getCatalogItem).mock.calls.at(-1)?.[1]?.signal;
    element.remove();
    expect(signal?.aborted).toBe(true);
  });

  it("searches and pages through one client, resetting offset on a query change", async () => {
    const client = source();
    vi.mocked(client.listCatalog).mockImplementation(async (request) => ({
      items: [card],
      total: 25,
      offset: request.offset ?? 0,
      limit: 12,
      facets: { kind: [{ value: "dataset", label: "Datasets", count: 25 }] },
    }));
    const element = mount("honua-catalog-search", client);
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe("Flood zones"));
    const next = element.shadowRoot?.querySelector<HTMLButtonElement>('[data-page="next"]');
    next?.focus();
    next?.click();
    await vi.waitFor(() => expect(vi.mocked(client.listCatalog).mock.calls.at(-1)?.[0].offset).toBe(12));
    await vi.waitFor(() => expect((element.shadowRoot?.activeElement as HTMLElement)?.dataset.page).toBe("next"));
    const input = element.shadowRoot?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error("Search input missing");
    input.value = "river";
    element.shadowRoot?.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(vi.mocked(client.listCatalog).mock.calls.at(-1)?.[0]).toMatchObject({ q: "river", offset: 0 }),
    );
    expect(client.getCatalogItem).not.toHaveBeenCalled();
  });

  it("does not publish denied payloads in state events", async () => {
    const client = source();
    vi.mocked(client.listCatalog).mockRejectedValue({ status: 403, message: "Hidden title" });
    const element = mount("honua-catalog-search", client);
    const listener = vi.fn();
    element.addEventListener("honua-catalog-state-change", listener);
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
    expect(JSON.stringify(listener.mock.calls.map(([event]) => event.detail))).not.toContain("Hidden title");
  });

  it("stops retrying an inconsistent empty page", async () => {
    const client = source();
    vi.mocked(client.listCatalog).mockImplementation(async (request) => ({
      items: request.offset ? [] : [card],
      total: 13,
      offset: request.offset ?? 0,
      limit: 12,
      facets: {},
    }));
    const element = mount("honua-catalog-search", client);
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("h2")).not.toBeNull());
    const next = element.shadowRoot?.querySelector<HTMLButtonElement>('[data-page="next"]');
    next?.focus();
    next?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
    expect(vi.mocked(client.listCatalog)).toHaveBeenCalledTimes(2);
  });
});
