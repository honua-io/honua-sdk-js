import { expect, it, vi } from "vitest";

import { awaitAbortable } from "../src/connect-endpoint.js";
import { connect } from "../src/connect.js";
import { HonuaAbortError } from "../src/core/errors.js";

it.each([new Error("Caller cancelled discovery"), "navigation", null])(
  "connect() preserves a pre-aborted caller reason %s without requests",
  async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const fetchFn = vi.fn<typeof fetch>();
    const error = await connect({
      endpoint: "https://example.test/FeatureServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      signal: controller.signal,
      clientOptions: { fetchFn },
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HonuaAbortError);
    expect((error as HonuaAbortError).sdkCode).toBe("core.cancelled");
    expect((error as HonuaAbortError).cause).toBe(reason);
    expect(fetchFn).not.toHaveBeenCalled();
  },
);

it("connect() preserves cancellation while an asynchronous cache hook ignores its signal", async () => {
  const controller = new AbortController();
  const reason = new Error("Cache wait cancelled");
  const fetchFn = vi.fn<typeof fetch>();
  let cacheStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    cacheStarted = resolve;
  });
  const pending = connect({
    endpoint: "https://example.test/api",
    protocol: "ogc-features",
    authorizationScopeFingerprint: "anonymous",
    signal: controller.signal,
    clientOptions: { fetchFn },
    cache: {
      get: () => {
        cacheStarted();
        return new Promise(() => {});
      },
      set: vi.fn(),
    },
  });
  await started;
  controller.abort(reason);
  const error = await pending.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(HonuaAbortError);
  expect((error as HonuaAbortError).cause).toBe(reason);
  expect(fetchFn).not.toHaveBeenCalled();
});

it("awaitAbortable preserves cancellation observed after a hook has already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let error: unknown;
  try {
    await awaitAbortable(Promise.resolve(undefined), controller.signal);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HonuaAbortError);
  expect((error as HonuaAbortError).cause).toBe(controller.signal.reason);
});
