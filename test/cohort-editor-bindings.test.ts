import { describe, expect, it } from "vitest";
import { localLayerUrl } from "../experiments/esri-cohort/editor/src/bindings.js";

const origin = "http://127.0.0.1:18624";
const path = "/rest/services/onboarding-editor-hazards-003/FeatureServer/5";

describe("editor onboarding write boundary", () => {
  it("accepts a receipt-bound local layer", () => {
    expect(localLayerUrl(path, origin).href).toBe(`${origin}${path}`);
  });

  it.each([
    undefined,
    "https://services.arcgis.com/example/arcgis/rest/services/Hazards/FeatureServer/0",
    `http://127.0.0.1:18615${path}`,
    `//example.com${path}`,
    "/rest/services/customer-production/FeatureServer/5",
    `${path}?token=do-not-send`,
    `${path}#fragment`,
    `${path}/applyEdits`,
    `http://user:password@127.0.0.1:18624${path}`,
  ])("rejects external, credential-bearing or non-cohort binding %s", (value) => {
    expect(() => localLayerUrl(value, origin)).toThrow();
  });

  it("rejects hosting the writable experiment on a remote origin", () => {
    expect(() => localLayerUrl(path, "https://example.com")).toThrow();
  });
});
