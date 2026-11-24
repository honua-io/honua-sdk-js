import { describe, expect, it } from "vitest";

import { createHonuaApplicationContext } from "../src/web-components/application-context.js";
import { type HonuaSdkSource, adoptHonuaSdkSource } from "../src/web-components/index.js";

function sdkSourceStub(): HonuaSdkSource {
  return {
    descriptor: { id: "parcels" },
    protocol: () => undefined,
    adapter: () => undefined,
  } as unknown as HonuaSdkSource;
}

describe("adoptHonuaSdkSource", () => {
  it("returns the same source object for an app-platform binding", () => {
    const sdkSource = sdkSourceStub();
    const source = adoptHonuaSdkSource(sdkSource);
    const context = createHonuaApplicationContext({ binding: { source } });

    expect(source).toBe(sdkSource);
    expect(context.snapshot.binding.source).toBe(sdkSource);
  });
});
