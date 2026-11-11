// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogClientFixture, mountCatalogFixture } from "./fixtures/catalog-components/elements.js";

afterEach(() => document.body.replaceChildren());

describe("catalog endpoints and Released lineage", () => {
  it("renders only advertised safe endpoints and copies through an explicit action", async () => {
    const client = catalogClientFixture();
    client.getCatalogItem = vi.fn(async () => ({
      id: "roads",
      kind: "service",
      title: "Roads",
      summary: null,
      detailHref: "https://catalog.example/roads",
      releasedVersionId: null,
      endpoints: [
        { protocol: "ogc-features", href: "https://catalog.example/ogc", mediaType: "application/json" },
        { protocol: "unsafe", href: "https://catalog.example/?token=secret", mediaType: null },
      ],
    }));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const element = mountCatalogFixture("honua-service-endpoints", client, (element) => {
      element.setAttribute("service", "roads");
      element.setAttribute("copy", "");
    });
    await vi.waitFor(() => expect(element.shadowRoot?.querySelectorAll("a")).toHaveLength(1));
    expect(writeText).not.toHaveBeenCalled();
    (element.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("https://catalog.example/ogc"));
    expect(element.shadowRoot?.textContent).not.toContain("secret");
  });

  it("rejects ambiguous identity before any visitor read", async () => {
    const client = catalogClientFixture();
    const element = mountCatalogFixture("honua-service-endpoints", client, (element) => {
      element.setAttribute("service", "roads");
      element.setAttribute("layer", "roads");
    });
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("exactly one"));
    expect(client.getCatalogItem).not.toHaveBeenCalled();
  });

  it("renders Released apps and maps from lineage, never an unfiltered catalog search", async () => {
    const client = {
      ...catalogClientFixture(),
      listCatalogAppsUsing: vi.fn(async () => ({
        catalogId: "open-data",
        subject: { kind: "service" as const, id: "roads" },
        items: [
          {
            id: "evacuation",
            kind: "app",
            title: "Evacuation",
            summary: null,
            detailHref: "https://catalog.example/apps/evacuation",
            releasedVersionId: "released-1",
          },
        ],
        total: 1,
        offset: 0,
        limit: 12,
        facets: {},
      })),
    };
    const element = mountCatalogFixture("honua-apps-using", client, (element) =>
      element.setAttribute("service", "roads"),
    );
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("article")?.textContent).toContain("Evacuation"));
    expect(client.listCatalog).not.toHaveBeenCalled();
    expect(client.listCatalogAppsUsing).toHaveBeenCalledWith(
      { catalogId: "open-data", kind: "service", id: "roads", offset: 0, limit: 12 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("reports missing lineage capability without falling back to a fixture", async () => {
    const element = mountCatalogFixture("honua-apps-using", catalogClientFixture(), (element) =>
      element.setAttribute("service", "roads"),
    );
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("not supported"));
    expect(element.shadowRoot?.querySelector("article")).toBeNull();
  });
});

const releasedApp = {
  id: "evacuation",
  kind: "app",
  title: "Evacuation",
  summary: null,
  detailHref: "https://catalog.example/apps/evacuation",
  releasedVersionId: "released-1",
};
const relationPage = {
  catalogId: "open-data",
  subject: { kind: "service" as const, id: "roads" },
  items: [releasedApp],
  total: 1,
  offset: 0,
  limit: 12,
  facets: {},
  structuredData: {
    "@context": { schema: "https://schema.org/" },
    "@graph": [{ "@id": "https://catalog.example/apps/evacuation", "@type": "schema:WebApplication" }],
  },
};

it.each([
  { ...relationPage, catalogId: "private" },
  { ...relationPage, subject: { kind: "service" as const, id: "private" } },
  { ...relationPage, items: [{ ...releasedApp, releasedVersionId: null }] },
  { ...relationPage, items: [{ ...releasedApp, kind: "service" }] },
  { ...relationPage, items: [{ ...releasedApp, detailHref: "javascript:alert(1)" }] },
  { ...relationPage, items: [], total: 3 },
  { ...relationPage, offset: 1 },
  { ...relationPage, limit: 1 },
  { ...relationPage, total: -1 },
])("refuses mismatched or unreleased lineage without emitting structured data", async (page) => {
  const client = { ...catalogClientFixture(), listCatalogAppsUsing: vi.fn(async () => page) };
  const projections = vi.fn();
  const element = mountCatalogFixture("honua-apps-using", client, (element) =>
    { element.setAttribute("service", "roads"); element.addEventListener("honua-catalog-structured-data-change", projections); },
  );
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
  expect(element.shadowRoot?.querySelector("article")).toBeNull();
  expect(document.querySelector("script[type='application/ld+json']")).toBeNull();
  expect(projections).not.toHaveBeenCalled();
});

it("clears endpoint links and JSON-LD as soon as the visitor client is revoked", async () => {
  const client = catalogClientFixture();
  client.getCatalogItem = vi.fn(async () => ({
    ...releasedApp,
    id: "roads",
    kind: "service",
    endpoints: [{ protocol: "wms", href: "https://catalog.example/wms", mediaType: null }],
    structuredData: {
      "@context": { schema: "https://schema.org/" },
      "@graph": [{ "@id": "https://catalog.example/services/roads", "@type": "schema:Service" }],
    },
  }));
  const element = mountCatalogFixture("honua-service-endpoints", client, (element) =>
    element.setAttribute("service", "roads"),
  );
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("a")).not.toBeNull());
  expect(document.querySelector("script[type='application/ld+json']")).not.toBeNull();
  expect(document.querySelector("script[type='application/ld+json']")?.textContent).toContain("https://catalog.example/services/roads");
  element.client = undefined;
  expect(element.shadowRoot?.querySelector("a")).toBeNull();
  expect(document.querySelector("script[type='application/ld+json']")).toBeNull();
});

it.each(["identity", "client"])("keeps the current lineage after %s replacement and aborts the old read", async (replacement) => {
  let resolve!: (page: typeof relationPage) => void;
  let signal!: AbortSignal;
  const client = { ...catalogClientFixture(), listCatalogAppsUsing: vi.fn((_query, options) => {
    signal = options.signal;
    return new Promise<typeof relationPage>(accept => { resolve = accept; });
  }) };
  const element = mountCatalogFixture("honua-apps-using", client, element => element.setAttribute("service", "roads"));
  const currentPage = { ...relationPage, subject: { ...relationPage.subject, id: replacement === "identity" ? "new" : "roads" },
    items: [{ ...releasedApp, title: "Current app" }] };
  if (replacement === "identity") element.setAttribute("service", "new");
  const replacementClient = { ...catalogClientFixture(), listCatalogAppsUsing: vi.fn(async () => currentPage) };
  element.client = replacementClient;
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Current app"));
  resolve({ ...relationPage, items: [{ ...releasedApp, title: "Stale app" }] });
  await new Promise(accept => setTimeout(accept, 0));
  expect(signal.aborted).toBe(true);
  expect(element.shadowRoot?.textContent).toContain("Current app");
  expect(element.shadowRoot?.textContent).not.toContain("Stale app");
  expect(element.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain("1 apps and maps");
  expect(document.querySelector("script[type='application/ld+json']")?.textContent).toContain(releasedApp.detailHref);
});

it("paginates lineage and recovers when the visible total shrinks", async () => {
  let shrink = false;
  const client = {
    ...catalogClientFixture(),
    listCatalogAppsUsing: vi.fn(async (query: { offset: number; limit: number }) => ({
      ...relationPage,
      offset: query.offset,
      limit: query.limit,
      total: shrink ? 0 : 2,
      items: shrink ? [] : [{ ...releasedApp, id: String(query.offset) }],
    })),
  };
  const element = mountCatalogFixture("honua-apps-using", client, (element) => {
    element.setAttribute("service", "roads");
    element.setAttribute("limit", "1");
    element.setAttribute("view", "table");
  });
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("tbody a")).not.toBeNull());
  (element.shadowRoot?.querySelectorAll("nav button")[1] as HTMLButtonElement).click();
  await vi.waitFor(() => expect(client.listCatalogAppsUsing).toHaveBeenCalledTimes(2));
  shrink = true;
  element.refresh();
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("No Released"));
  expect(client.listCatalogAppsUsing.mock.lastCall?.[0].offset).toBe(0);
});

it("narrows advertised protocols and announces denied clipboard access without a copied event", async () => {
  const client = catalogClientFixture();
  client.getCatalogItem = vi.fn(async () => ({
    ...releasedApp,
    id: "roads",
    kind: "layer",
    endpoints: [
      { protocol: "wms", href: "https://catalog.example/wms", mediaType: null },
      { protocol: "wfs", href: "https://catalog.example/wfs", mediaType: null },
    ],
  }));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => {
        throw new Error("denied");
      }),
    },
  });
  const element = mountCatalogFixture("honua-service-endpoints", client, (element) => {
    element.setAttribute("layer", "roads");
    element.setAttribute("protocols", "wms");
    element.setAttribute("copy", "");
  });
  const copied = vi.fn();
  element.addEventListener("honua-endpoint-copy", copied);
  await vi.waitFor(() => expect(element.shadowRoot?.querySelectorAll("a")).toHaveLength(1));
  expect(element.shadowRoot?.textContent).not.toContain("wfs");
  (element.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Copy is unavailable"));
  expect(copied).not.toHaveBeenCalled();
});

it.each(["cards", "table"])("allows hosts to cancel %s navigation", async (view) => {
  const client = { ...catalogClientFixture(), listCatalogAppsUsing: vi.fn(async () => relationPage) };
  const element = mountCatalogFixture("honua-apps-using", client, (element) => {
    element.setAttribute("service", "roads");
    element.setAttribute("view", view);
  });
  const activate = vi.fn((event: Event) => event.preventDefault());
  element.addEventListener("honua-catalog-item-activate", activate);
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("a")).not.toBeNull());
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  element.shadowRoot?.querySelector("a")?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(activate).toHaveBeenCalledTimes(1);
  expect((activate.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind: "app", id: "evacuation", href: releasedApp.detailHref });
});

it("keeps keyboard focus when a shrinking total recovers to a nonzero last page", async () => {
  let shrink = false;
  const client = { ...catalogClientFixture(), listCatalogAppsUsing: vi.fn(async (query: {offset:number; limit:number}) => ({
    ...relationPage, offset: query.offset, limit: query.limit, total: shrink ? 2 : 4,
    items: shrink && query.offset >= 2 ? [] : [releasedApp],
  })) };
  const element = mountCatalogFixture("honua-apps-using", client, (element) => {
    element.setAttribute("service", "roads"); element.setAttribute("limit", "1");
  });
  await vi.waitFor(() => expect(element.shadowRoot?.querySelector("article")).not.toBeNull());
  (element.shadowRoot?.querySelectorAll("nav button")[1] as HTMLButtonElement).click();
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("2–2 of 4"));
  shrink = true;
  const next = element.shadowRoot?.querySelectorAll("nav button")[1] as HTMLButtonElement;
  next.focus(); next.click();
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("2–2 of 2"));
  expect((element.shadowRoot?.activeElement as HTMLElement)?.dataset.focus).toBe("previous");
  expect(client.listCatalogAppsUsing).toHaveBeenCalledTimes(4);
});

it.each(["0", "101", "1.5"])("rejects invalid lineage limit %s before reading", async (limit) => {
  const client = { ...catalogClientFixture(), listCatalogAppsUsing: vi.fn(async () => relationPage) };
  const element = mountCatalogFixture("honua-apps-using", client, element => {
    element.setAttribute("service", "roads"); element.setAttribute("limit", limit);
  });
  expect(element.shadowRoot?.textContent).toContain("Configure");
  expect(client.listCatalogAppsUsing).not.toHaveBeenCalled();
});
