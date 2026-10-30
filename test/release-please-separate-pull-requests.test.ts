import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("release-please component pull requests", () => {
  it("splits component releases so create-honua-app can publish without js-sdk 0.3.0", () => {
    const config = JSON.parse(readFileSync(resolve("release-please-config.json"), "utf8")) as {
      "separate-pull-requests"?: boolean;
    };
    expect(config["separate-pull-requests"]).toBe(true);
  });
});
