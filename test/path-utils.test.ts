import { describe, expect, it } from "vitest";
import { encodeServiceIdPath } from "../src/core/path-utils.js";

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
