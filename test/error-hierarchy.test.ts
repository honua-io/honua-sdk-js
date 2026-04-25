import { describe, expect, it } from "vitest";

import {
  HonuaAbortError,
  HonuaCapabilityNotSupportedError,
  HonuaClient,
  HonuaExplorationContextError,
  HonuaGrpcError,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaTimeoutError,
  HonuaWmsCapabilitiesParseError,
  HonuaWmtsCapabilitiesParseError,
  isHonuaError,
} from "../src/index.js";

describe("Error hierarchy", () => {
  describe("HonuaTimeoutError", () => {
    it("exposes timeoutMs", () => {
      const err = new HonuaTimeoutError(5000);
      expect(err.timeoutMs).toBe(5000);
      expect(err.name).toBe("HonuaTimeoutError");
      expect(err.message).toContain("5000");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(HonuaTimeoutError);
    });

    it("is thrown on timeout via slow fetch", async () => {
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        timeoutMs: 50,
        fetchFn: (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              if (signal.aborted) {
                reject(signal.reason ?? new DOMException("signal is aborted without reason", "AbortError"));
                return;
              }
              signal.addEventListener("abort", () => {
                reject(signal.reason ?? new DOMException("signal is aborted without reason", "AbortError"));
              });
            }
          }),
      });

      await expect(client.queryFeatures({ serviceId: "svc", layerId: 0 })).rejects.toThrow(HonuaTimeoutError);
    }, 10_000);
  });

  describe("HonuaNetworkError", () => {
    it("wraps underlying cause", () => {
      const cause = new TypeError("Failed to fetch");
      const err = new HonuaNetworkError("Network failure", cause);
      expect(err.name).toBe("HonuaNetworkError");
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(Error);
    });

    it("is thrown on fetch failure", async () => {
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        fetchFn: () => Promise.reject(new TypeError("Failed to fetch")),
      });

      await expect(client.queryFeatures({ serviceId: "svc", layerId: 0 })).rejects.toThrow(HonuaNetworkError);
    });
  });

  describe("HonuaAbortError", () => {
    it("has correct name and message", () => {
      const err = new HonuaAbortError();
      expect(err.name).toBe("HonuaAbortError");
      expect(err.message).toBe("Request was aborted");
      expect(err).toBeInstanceOf(Error);
    });

    it("is thrown when a pre-aborted signal is passed", async () => {
      const controller = new AbortController();
      controller.abort();

      const client = new HonuaClient({
        baseUrl: "https://example.test",
        fetchFn: async (_input, init) => {
          init?.signal?.throwIfAborted();
          return new Response("ok");
        },
      });

      await expect(
        client.queryFeatures({
          serviceId: "svc",
          layerId: 0,
          signal: controller.signal,
        }),
      ).rejects.toThrow(HonuaAbortError);
    });
  });

  describe("HonuaGrpcError", () => {
    it("exposes code and details", () => {
      const err = new HonuaGrpcError(14, "unavailable", { raw: true });
      expect(err.name).toBe("HonuaGrpcError");
      expect(err.code).toBe(14);
      expect(err.details).toEqual({ raw: true });
      expect(err.message).toBe("unavailable");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("HonuaCapabilityNotSupportedError", () => {
    it("exposes capability, protocol, sourceId and crafts a clear message", () => {
      const err = new HonuaCapabilityNotSupportedError("queryAggregate", "ogc-features", "parcels-ogc");
      expect(err.name).toBe("HonuaCapabilityNotSupportedError");
      expect(err.capability).toBe("queryAggregate");
      expect(err.protocol).toBe("ogc-features");
      expect(err.sourceId).toBe("parcels-ogc");
      expect(err.message).toContain("queryAggregate");
      expect(err.message).toContain("ogc-features");
      expect(err.message).toContain("parcels-ogc");
      expect(err).toBeInstanceOf(Error);
    });

    it("omits the source id from the message when not provided", () => {
      const err = new HonuaCapabilityNotSupportedError("render", "wfs");
      expect(err.sourceId).toBeUndefined();
      expect(err.message).not.toContain("undefined");
    });
  });

  describe("HonuaExplorationContextError", () => {
    it("exposes a code and message", () => {
      const err = new HonuaExplorationContextError("disposed", "context disposed");
      expect(err.name).toBe("HonuaExplorationContextError");
      expect(err.code).toBe("disposed");
      expect(err.message).toBe("context disposed");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("HonuaWmsCapabilitiesParseError", () => {
    it("carries the parser message and is an Error", () => {
      const err = new HonuaWmsCapabilitiesParseError("missing <WMS_Capabilities> root element");
      expect(err.name).toBe("HonuaWmsCapabilitiesParseError");
      expect(err.message).toContain("WMS_Capabilities");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("HonuaWmtsCapabilitiesParseError", () => {
    it("carries the parser message and is an Error", () => {
      const err = new HonuaWmtsCapabilitiesParseError("missing <Capabilities> root element");
      expect(err.name).toBe("HonuaWmtsCapabilitiesParseError");
      expect(err.message).toContain("Capabilities");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("isHonuaError", () => {
    it("returns true for all SDK error types", () => {
      expect(isHonuaError(new HonuaHttpError(404, "not found", null))).toBe(true);
      expect(isHonuaError(new HonuaTimeoutError(1000))).toBe(true);
      expect(isHonuaError(new HonuaNetworkError("fail", null))).toBe(true);
      expect(isHonuaError(new HonuaAbortError())).toBe(true);
      expect(isHonuaError(new HonuaGrpcError(2, "unknown"))).toBe(true);
      expect(isHonuaError(new HonuaCapabilityNotSupportedError("query", "wfs"))).toBe(true);
      expect(isHonuaError(new HonuaExplorationContextError("disposed", "ctx"))).toBe(true);
      expect(isHonuaError(new HonuaWmsCapabilitiesParseError("missing root"))).toBe(true);
      expect(isHonuaError(new HonuaWmtsCapabilitiesParseError("missing root"))).toBe(true);
    });

    it("returns false for plain Error and non-Error values", () => {
      expect(isHonuaError(new Error("plain"))).toBe(false);
      expect(isHonuaError("string")).toBe(false);
      expect(isHonuaError(null)).toBe(false);
      expect(isHonuaError(undefined)).toBe(false);
    });
  });
});
