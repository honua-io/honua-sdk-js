// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  catalogCardFixture,
  catalogClientFixture,
  mountCatalogFixture,
} from "./fixtures/catalog-components/elements.js";

afterEach(() => document.body.replaceChildren());

it("bounds search recovery when visible totals shrink repeatedly", async () => {
  let shrinking = false;
  let recoveries = 0;
  const client = catalogClientFixture();
  client.listCatalog = vi.fn(async (query) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      items: shrinking ? [] : [catalogCardFixture],
      total: shrinking ? Math.max(0, 2 - recoveries++) : 4,
      offset: query.offset ?? 0,
      limit: query.limit ?? 1,
      facets: {},
    };
  });
  const element = mountCatalogFixture("honua-catalog-search", client, (element) => element.setAttribute("limit", "1"));
  for (const text of ["1–1 of 4", "2–2 of 4"]) {
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain(text));
    (element.shadowRoot?.querySelectorAll("nav button")[1] as HTMLButtonElement).click();
  }
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("3–3 of 4"));
  shrinking = true;
  element.refresh();
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("unavailable"));
  expect(recoveries).toBe(2);
});
