import { HonuaOnlineBasemapBinding } from "@honua/sdk-js/runtime";
import type { HonuaOnlineBasemapTheme } from "@honua/sdk-js/runtime";
import type { Map as MapLibreMap } from "maplibre-gl";

/** Explicit live-lane enhancement. Local fixture lanes never call this helper. */
export function mountSampleOnlineBasemap(
  map: MapLibreMap,
  options: {
    readonly styleUrl?: string;
    readonly lightTheme?: Exclude<HonuaOnlineBasemapTheme, "dark">;
    readonly styleEnvironmentVariable?: string;
  } = {},
): () => void {
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.dataset.basemapStatus = "loading";
  notice.style.cssText =
    "position:absolute;left:12px;right:12px;bottom:40px;z-index:5;padding:8px 12px;background:Canvas;color:CanvasText;border:1px solid currentColor;border-radius:6px;font:13px system-ui;pointer-events:none;display:none";
  map.getContainer().append(notice);
  const binding = new HonuaOnlineBasemapBinding(map, {
    onError: (message) => {
      notice.textContent = `${message} Set ${options.styleEnvironmentVariable ?? "VITE_HONUA_BASEMAP_STYLE"} to your custom/self-hosted style URL.`;
      notice.dataset.basemapStatus = "error";
      notice.style.display = "block";
    },
    onReady: () => {
      notice.textContent = "";
      notice.dataset.basemapStatus = "ready";
      notice.style.display = "none";
    },
  });
  const preferred = matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    if (!map.isStyleLoaded()) return;
    const selected = document.documentElement.dataset.theme;
    const dark = selected === "dark" || (!selected && preferred.matches);
    void binding.activate({ theme: dark ? "dark" : (options.lightTheme ?? "positron"), styleUrl: options.styleUrl });
  };
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  preferred.addEventListener("change", update);
  if (map.isStyleLoaded()) update();
  else map.once("load", update);
  const dispose = () => {
    map.off("load", update);
    observer.disconnect();
    preferred.removeEventListener("change", update);
    binding.dispose();
    notice.remove();
  };
  // Dispose before remove(), while the renderer's style resources still exist.
  return dispose;
}
