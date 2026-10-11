import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";

function renderer() {
  const notice = {
    setAttribute: vi.fn(),
    dataset: {} as Record<string, string>,
    style: { cssText: "", display: "" },
    textContent: "",
    remove: vi.fn(),
  };
  let loaded = false;
  let onLoad: (() => void) | undefined;
  const map = {
    getContainer: () => ({ append: vi.fn() }),
    isStyleLoaded: () => loaded,
    once: (_event: string, callback: () => void) => {
      onLoad = callback;
    },
    off: vi.fn(),
  };
  let onTheme: (() => void) | undefined;
  vi.stubGlobal("document", { createElement: () => notice, documentElement: { dataset: {} } });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        onTheme = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  return {
    map: map as unknown as MapLibreMap,
    notice,
    changeTheme: () => onTheme?.(),
    load: () => {
      loaded = true;
      onLoad?.();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@honua/sdk-js/runtime");
  vi.resetModules();
});

describe("sample basemap activation", () => {
  it("defers theme mutations until the host style has loaded", async () => {
    const activate = vi.fn().mockResolvedValue(true);
    vi.doMock("@honua/sdk-js/runtime", () => ({
      HonuaOnlineBasemapBinding: class {
        activate = activate;
        dispose() {}
      },
    }));
    const { mountSampleOnlineBasemap } = await import("../examples/shared/online-basemap.js");
    const fixture = renderer();
    const dispose = mountSampleOnlineBasemap(fixture.map);
    fixture.changeTheme();
    expect(activate).not.toHaveBeenCalled();
    fixture.load();
    expect(activate).toHaveBeenCalledWith({ theme: "positron", styleUrl: undefined });
    dispose();
  });

  it("gives older installed SDKs an actionable live-lane upgrade notice", async () => {
    vi.doMock("@honua/sdk-js/runtime", () => ({ HonuaOnlineBasemapBinding: undefined }));
    const { mountSampleOnlineBasemap } = await import("../examples/shared/online-basemap-compat.js");
    const fixture = renderer();
    const dispose = mountSampleOnlineBasemap(fixture.map);
    expect(fixture.notice.dataset.basemapStatus).toBe("error");
    expect(fixture.notice.textContent).toContain("Upgrade @honua/sdk-js");
    expect(fixture.notice.textContent).toContain("Operational data remains usable");
    dispose();
    expect(fixture.notice.remove).toHaveBeenCalledOnce();
  });
});
