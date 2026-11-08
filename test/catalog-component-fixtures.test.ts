import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CatalogSearchProjection } from "../src/catalog-components/presentation.js";
import type { CatalogPage } from "./fixtures/catalog-components/draft-contract.js";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/catalog-components/catalog-mock-fixtures.json", import.meta.url), "utf8"),
) as {
  responses: Record<string, CatalogPage>;
};

describe("draft catalog fixture presentation boundary", () => {
  it("accepts the server owner's draft search projection without a second transport", () => {
    const page: CatalogSearchProjection = fixtures.responses.publicAnonymous;
    expect(page.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["dataset", "layer", "service", "map", "app"]),
    );
  });
  it("preserves the public anonymous ceiling for signed-in fixture readers", () => {
    expect(fixtures.responses.publicSignedIn).toEqual(fixtures.responses.publicAnonymous);
    expect(fixtures.responses.staffSignedIn.items.length).toBeGreaterThan(
      fixtures.responses.publicAnonymous.items.length,
    );
  });
});
