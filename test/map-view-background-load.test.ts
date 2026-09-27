// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/esri-compat/map-view-mount.js", async () => {
  const actual = await vi.importActual<typeof import("../src/esri-compat/map-view-mount.js")>(
    "../src/esri-compat/map-view-mount.js",
  );
  return {
    ...actual,
    mountCompatMap: vi.fn(async () => undefined),
  };
});

import { MapViewCompat } from "../src/esri-compat/map-view.js";

describe("MapViewCompat background load", () => {
  it("rejects a discarded when() without an unhandled rejection", async () => {
    const reasons: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      reasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const container = document.createElement("div");
      const view = new MapViewCompat({ container });
      void view.when();

      await vi.waitFor(() => {
        expect(view.loadStatus).toBe("failed");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reasons).toEqual([]);
      await expect(view.when()).rejects.toThrow(
        "The map renderer did not start. Install maplibre-gl in a browser view container.",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
