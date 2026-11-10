import { describe, expect, it } from "vitest";

import {
  clientConfig,
  clientRequest,
  esriConfig,
  esriRequest,
  getClientConfigHonuaInterceptors,
  getEsriConfigHonuaInterceptors,
  resetClientConfig,
  resetEsriConfig,
} from "../src/client-compat-entry.js";

describe("client-compat deprecated aliases for migrated code", () => {
  it("keeps every name the published migrator emits pointing at the renamed export", () => {
    expect(esriConfig).toBe(clientConfig);
    expect(esriRequest).toBe(clientRequest);
    expect(resetEsriConfig).toBe(resetClientConfig);
    expect(getEsriConfigHonuaInterceptors).toBe(getClientConfigHonuaInterceptors);
  });
});
