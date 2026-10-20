import * as runtime from "@honua/sdk-js/runtime";

type HonuaOnlineBasemapTheme = "positron" | "liberty" | "dark";
interface OnlineBasemapBinding {
  activate(options: { theme: HonuaOnlineBasemapTheme; styleUrl?: string }): Promise<boolean>;
  dispose(): void;
}
type OnlineBasemapConstructor = new (
  map: MapLibreMap,
  options: { onError: (message: string) => void; onReady: () => void },
) => OnlineBasemapBinding;
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
  // Older published SDKs can still run the local fixture lane. A live map
  // explicitly reports the required upgrade instead of failing module loading.
  const Binding = (runtime as unknown as { readonly HonuaOnlineBasemapBinding?: OnlineBasemapConstructor })
    .HonuaOnlineBasemapBinding;
  if (typeof Binding !== "function") {
    notice.textContent =
      "Online basemaps require a newer @honua/sdk-js release with HonuaOnlineBasemapBinding. Upgrade @honua/sdk-js after the basemap SDK release is published, then reload. Operational data remains usable.";
    notice.dataset.basemapStatus = "error";
    notice.style.display = "block";
    return () => notice.remove();
  }
  const binding = new Binding(map, {
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
  let pendingTheme: HonuaOnlineBasemapTheme | undefined;
  const flush = () => {
    if (!pendingTheme || !map.isStyleLoaded()) return;
    const theme = pendingTheme;
    pendingTheme = undefined;
    void binding.activate({ theme, styleUrl: options.styleUrl });
  };
  const update = () => {
    const selected = document.documentElement.dataset.theme;
    const dark = selected === "dark" || (!selected && preferred.matches);
    pendingTheme = dark ? "dark" : (options.lightTheme ?? "positron");
    flush();
  };
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  preferred.addEventListener("change", update);
  // Theme changes during tile/sprite loading must survive until the renderer
  // is ready again. Consume only the latest pending theme, once per update.
  map.on("idle", flush);
  map.once("load", flush);
  update();
  const dispose = () => {
    map.off("load", flush);
    map.off("idle", flush);
    observer.disconnect();
    preferred.removeEventListener("change", update);
    binding.dispose();
    notice.remove();
  };
  // Dispose before remove(), while the renderer's style resources still exist.
  return dispose;
}
