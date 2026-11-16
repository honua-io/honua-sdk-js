import { beforeAll, describe, expect, it, vi } from "vitest";

import { createHonuaControlPlane } from "../src/control-plane/index.js";
import { HonuaHttpError } from "../src/core/errors.js";

describe("control-plane with a separate SDK module copy", () => {
  let ForeignClient: typeof import("../src/core/client.js").HonuaClient;
  let ForeignHttpError: typeof HonuaHttpError;

  beforeAll(async () => {
    // Split packages copy core modules: their constructors have different identities.
    vi.resetModules();
    ({ HonuaClient: ForeignClient } = await import("../src/core/client.js"));
    ({ HonuaHttpError: ForeignHttpError } = await import("../src/core/errors.js"));
    expect(ForeignHttpError).not.toBe(HonuaHttpError);
  });

  for (const method of ["json", "page"] as const) {
    const invoke = (client: ReturnType<typeof createHonuaControlPlane>) =>
      method === "json" ? client.getCapabilityManifest() : client.requestPage("raw", "/missing");

    it.each([404, 501])(`returns unsupported for ${method} HTTP %i from the foreign SDK`, async (status) => {
      const body = { title: "Unsupported endpoint", status };
      const client = createHonuaControlPlane({
        client: new ForeignClient({
          baseUrl: "https://example.test",
          fetchFn: async () => new Response(JSON.stringify(body), { status }),
        }),
      });
      await expect(invoke(client)).resolves.toMatchObject({ supported: false, statusCode: status, problem: body });
    });

    it.each([404, 501])(`returns unsupported for a thrown ${method} HTTP %i from the foreign SDK`, async (status) => {
      const body = { title: "Unsupported endpoint", status };
      const sdk = new ForeignClient({ baseUrl: "https://example.test" });
      vi.spyOn(sdk, "pipelineFetch").mockRejectedValue(new ForeignHttpError(status, "Request failed", body));
      await expect(invoke(createHonuaControlPlane({ client: sdk }))).resolves.toMatchObject({
        supported: false,
        statusCode: status,
        problem: body,
      });
    });

    it.each([401, 403, 500])(`preserves ${method} HTTP %i failures from the foreign SDK`, async (status) => {
      const failure = new ForeignHttpError(status, "Request failed", { status });
      const sdk = new ForeignClient({ baseUrl: "https://example.test" });
      vi.spyOn(sdk, "pipelineFetch").mockRejectedValue(failure);
      await expect(invoke(createHonuaControlPlane({ client: sdk }))).rejects.toBe(failure);
    });

    it.each([
      new Error("Network failed"),
      { name: "HonuaHttpError", statusCode: 404, body: {} },
      { kind: "honua.sdk.error.v1", sdkCode: "core.http.rejected", statusCode: 501 },
    ])(`preserves unrelated ${method} failures`, async (failure) => {
      const sdk = new ForeignClient({ baseUrl: "https://example.test" });
      vi.spyOn(sdk, "pipelineFetch").mockRejectedValue(failure);
      await expect(invoke(createHonuaControlPlane({ client: sdk }))).rejects.toBe(failure);
    });
  }
});
