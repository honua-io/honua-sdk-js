import { describe, expect, it } from "vitest";
import { encodeServiceIdPath, trimTrailingCharsIn } from "../src/core/path-utils.js";

describe("encodeServiceIdPath", () => {
  it("encodes a flat serviceId exactly like encodeURIComponent", () => {
    expect(encodeServiceIdPath("MyService")).toBe("MyService");
    expect(encodeServiceIdPath("My Service")).toBe(encodeURIComponent("My Service"));
    expect(encodeServiceIdPath("My Service")).toBe("My%20Service");
  });

  it("preserves the slash between folder and service segments", () => {
    expect(encodeServiceIdPath("MyFolder/MyService")).toBe("MyFolder/MyService");
  });

  it("supports deeply nested folder paths", () => {
    expect(encodeServiceIdPath("a/b/c/Service")).toBe("a/b/c/Service");
  });

  it("percent-encodes special characters within each segment but keeps the separator", () => {
    expect(encodeServiceIdPath("My Folder/My Service")).toBe("My%20Folder/My%20Service");
    expect(encodeServiceIdPath("Pub & Roads/Layer A")).toBe("Pub%20%26%20Roads/Layer%20A");
  });

  it("drops empty segments from leading, trailing, or doubled slashes", () => {
    expect(encodeServiceIdPath("/MyFolder/MyService/")).toBe("MyFolder/MyService");
    expect(encodeServiceIdPath("MyFolder//MyService")).toBe("MyFolder/MyService");
  });
});

describe("trimTrailingCharsIn", () => {
  it("removes a trailing run of characters that belong to the given set", () => {
    expect(trimTrailingCharsIn("foo),.;]", "),.;]")).toBe("foo");
    expect(trimTrailingCharsIn("foo)bar;", "),.;]")).toBe("foo)bar");
  });

  it("leaves the value untouched when nothing trailing matches", () => {
    expect(trimTrailingCharsIn("foo", "),.;]")).toBe("foo");
    expect(trimTrailingCharsIn("", "),.;]")).toBe("");
  });

  it("stays linear-time on an adversarially long trailing run (js/polynomial-redos regression)", () => {
    // The equivalent regex, `/[),.;\]]+$/`, is an unanchored-at-the-start,
    // anchored-at-the-end quantifier that a backtracking engine can be
    // forced to retry at every start position on adversarial input.
    const adversarial = `x${")".repeat(500_000)}`;

    const start = performance.now();
    const result = trimTrailingCharsIn(adversarial, "),.;]");
    const elapsedMs = performance.now() - start;

    expect(result).toBe("x");
    expect(elapsedMs).toBeLessThan(1000);
  });
});
