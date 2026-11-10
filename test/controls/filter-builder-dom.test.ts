// @vitest-environment jsdom
import { expect, test } from "vitest";
import { defineHonuaFilterBuilder } from "../../src/controls/filter-builder-element.js";
import type { HonuaFilterBuilderElement } from "../../src/controls/filter-builder-element.js";

test("public apply reads current form values without a submit event", async () => {
  defineHonuaFilterBuilder();
  const element = document.createElement("honua-filter-builder") as HonuaFilterBuilderElement;
  element.draft = {
    fields: [{ name: "people", type: "number" }],
    rows: [{ field: "people", operator: "gte", value: "2" }],
    ownerId: "builder",
    sourceId: "towns",
  };
  document.body.append(element);
  try {
    element.shadowRoot!.querySelector<HTMLInputElement>("[data-value]")!.value = "9";
    expect((await element.apply()).cql2).toBe("people >= 9");
  } finally {
    element.remove();
  }
});
