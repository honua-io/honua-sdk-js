import { expect, test, vi } from "vitest";
import { HonuaCatalogPickerElement } from "../../src/controls/catalog-picker-element.js";
import { HonuaCatalogPicker } from "../../src/controls/catalog-picker.js";

test("renders native search and escaped catalog results, and releases its subscription on disconnect", async () => {
  const picker = new HonuaCatalogPicker({
    client: {
      searchOgcRecords: vi
        .fn()
        .mockResolvedValueOnce({
          type: "FeatureCollection",
          features: [
            { type: "Feature", id: "one", geometry: null, properties: { title: '<img src=x onerror="alert(1)">' } },
          ],
        })
        .mockResolvedValueOnce({
          type: "FeatureCollection",
          features: [{ type: "Feature", id: "two", geometry: null, properties: { title: "second-result" } }],
        }),
    },
    collectionId: "data",
    resolve: vi.fn(),
  });
  const element = new HonuaCatalogPickerElement();
  const shadow = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], activeElement: null };
  Object.defineProperty(element, "shadowRoot", { value: shadow });
  element.picker = picker;
  element.connectedCallback();
  expect(shadow.innerHTML).toContain('type="search"');
  expect(shadow.innerHTML).toContain('for="catalog-query"');
  await picker.search("towns");
  expect(shadow.innerHTML).toContain("&lt;img");
  expect(shadow.innerHTML).not.toContain("<img");
  expect(shadow.innerHTML).toContain('type="button"');
  expect(shadow.innerHTML).toContain('role="status"');
  element.disconnectedCallback();
  const previous = shadow.innerHTML;
  await picker.search("elsewhere");
  expect(shadow.innerHTML).toBe(previous);
  expect(shadow.innerHTML).not.toContain("second-result");
  // A borrowed model still belongs to its caller after the view disconnects.
  expect(picker.state.status).toBe("ready");
});
