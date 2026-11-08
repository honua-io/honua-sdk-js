// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import type { CatalogSearchProjection } from "../src/catalog-components/presentation.js";
import {
  catalogCardFixture as card,
  mountCatalogFixture as mount,
  catalogClientFixture as source,
} from "./fixtures/catalog-components/elements.js";

afterEach(() => document.body.replaceChildren());

const projection = {
  "@context": { schema: "https://schema.org/" },
  "@graph": [{ "@id": "https://catalog.example/1", "schema:name": "Visible title" }],
};

it("does not read a catalog superseded by its own query event", async () => {
  const client = source();
  vi.mocked(client.listCatalog).mockImplementation(async (query) => ({
    items: [{ ...card, title: query.catalogId }],
    total: 1,
    offset: 0,
    limit: 12,
    facets: {},
  }));
  const element = mount("honua-catalog-search", client, (element) => {
    element.setAttribute("catalog", "old");
    element.addEventListener("honua-catalog-query-change", (event) => {
      if ((event as CustomEvent).detail.catalogId === "old") element.setAttribute("catalog", "new");
    });
  });
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe("new"));
  expect(vi.mocked(client.listCatalog).mock.calls.map(([query]) => query.catalogId)).toEqual(["new"]);
  expect(element.shadowRoot?.textContent).not.toContain("old");
});

it("does not read a client superseded by the loading event", async () => {
  const previous = source();
  const current = source({ ...card, title: "Current visitor" });
  const element = mount("honua-dataset-card", previous, (element) => {
    element.addEventListener("honua-catalog-state-change", (event) => {
      if ((event as CustomEvent).detail.state === "loading" && element.client === previous) element.client = current;
    });
  });
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Current visitor"));
  expect(previous.getCatalogItem).not.toHaveBeenCalled();
});

it("notifies structured-data consumers when authorization clears or the element disconnects", async () => {
  const notifications: unknown[] = [];
  const client = source({ ...card, structuredData: projection });
  const element = mount("honua-dataset-card", client, (element) => {
    element.addEventListener("honua-catalog-structured-data-change", (event) =>
      notifications.push((event as CustomEvent).detail),
    );
  });
  await vi.waitFor(() => expect(notifications.at(-1)).toEqual(projection));
  element.client = undefined;
  expect(notifications.at(-1)).toBeNull();
  expect(document.querySelector("script[data-honua-catalog-structured-data]")).toBeNull();
  element.client = client;
  await vi.waitFor(() => expect(notifications.at(-1)).toEqual(projection));
  element.remove();
  expect(notifications.at(-1)).toBeNull();
});

it.each(["map", "app"])("rejects an unreleased %s in both standalone cards and page JSON-LD", async (kind) => {
  const client = source({ ...card, kind, structuredData: projection });
  vi.mocked(client.listCatalog).mockResolvedValue({
    items: [{ ...card, kind }],
    total: 1,
    offset: 0,
    limit: 12,
    facets: {},
    structuredData: projection,
  });
  const element = mount(`honua-${kind}-card`, client);
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
  expect(element.shadowRoot?.querySelector("article")).toBeNull();
  const search = mount("honua-catalog-search", client);
  await vi.waitFor(() => expect(search.shadowRoot?.textContent).toContain("unavailable"));
  expect(search.shadowRoot?.querySelector("article")).toBeNull();
  expect(document.querySelector("script[data-honua-catalog-structured-data]")).toBeNull();
  search.client = source({ ...card, kind, releasedVersionId: "released-v1", structuredData: projection });
  await vi.waitFor(() => expect(search.shadowRoot?.querySelector("article")).not.toBeNull());
});

it("lets the visitor retry a failed search through an accessible button", async () => {
  const client = source();
  vi.mocked(client.listCatalog).mockRejectedValueOnce(new Error("Temporary failure"));
  const element = mount("honua-catalog-search", client);
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
  const retry = [...(element.shadowRoot?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  retry?.click();
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe(card.title));
});

it("gives a fixed kind attribute precedence over a prior selection", async () => {
  const client = source();
  vi.mocked(client.listCatalog).mockResolvedValue({
    items: [card],
    total: 1,
    offset: 0,
    limit: 12,
    facets: { kind: ["dataset", "service", "map"].map((value) => ({ value, label: value, count: 1 })) },
  });
  const element = mount("honua-catalog-search", client);
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("select")).not.toBeNull());
  const select = element.shadowRoot?.querySelector("select");
  if (!select) throw new Error("Kind control missing");
  select.value = "dataset";
  select.dispatchEvent(new Event("change"));
  for (const kind of ["service", "map"]) {
    element.setAttribute("kind", kind);
    await vi.waitFor(() => expect(vi.mocked(client.listCatalog).mock.calls.at(-1)?.[0].kind).toEqual([kind]));
  }
  element.removeAttribute("kind");
  await vi.waitFor(() => expect(vi.mocked(client.listCatalog).mock.calls.at(-1)?.[0].kind).toBeUndefined());
});

it("keeps deliberately moved search focus when a pending filter request completes", async () => {
  const client = source();
  const page: CatalogSearchProjection = {
    items: [card],
    total: 1,
    offset: 0,
    limit: 12,
    facets: { kind: [{ value: "dataset", label: "Dataset", count: 1 }] },
  };
  vi.mocked(client.listCatalog).mockResolvedValueOnce(page);
  let finish!: (page: CatalogSearchProjection) => void;
  vi.mocked(client.listCatalog).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const element = mount("honua-catalog-search", client);
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("select")).not.toBeNull());
  const select = element.shadowRoot?.querySelector("select");
  if (!select) throw new Error("Kind control missing");
  select.focus();
  select.value = "dataset";
  select.dispatchEvent(new Event("change"));
  const search = element.shadowRoot?.querySelector<HTMLInputElement>('input[type="search"]');
  search?.focus();
  finish(page);
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("article")).not.toBeNull());
  expect(element.shadowRoot?.activeElement).toBe(search);
});
