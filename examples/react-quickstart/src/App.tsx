import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";

import { HonuaClient } from "@honua/sdk-js/honua";
import {
  HonuaMapProvider,
  HonuaProvider,
  HonuaSelectionProvider,
  HonuaSourceLayer,
  useCapabilities,
  useDataset,
  useHover,
  useQuery,
  useSelection,
} from "@honua/sdk-js/react";

import { resolveReactQuickstartConfig } from "./config.js";
import { BACKGROUND_STYLE, INITIAL_VIEW, QUICKSTART_RENDERER, QUICKSTART_SOURCE_ID, buildDescriptors } from "./data.js";

declare global {
  interface Window {
    __HONUA_REACT_QUICKSTART__?: {
      mapReady?: boolean;
      featureCount?: number;
      serverVersion?: string;
      selectedCount?: number;
      error?: string | null;
    };
  }
}

function patchStatus(patch: NonNullable<Window["__HONUA_REACT_QUICKSTART__"]>): void {
  window.__HONUA_REACT_QUICKSTART__ = { ...(window.__HONUA_REACT_QUICKSTART__ ?? {}), ...patch };
}

const config = resolveReactQuickstartConfig({
  VITE_HONUA_REACT_BASE_URL: import.meta.env.VITE_HONUA_REACT_BASE_URL,
  VITE_HONUA_REACT_LAYER_ID: import.meta.env.VITE_HONUA_REACT_LAYER_ID,
  VITE_HONUA_REACT_SERVICE_ID: import.meta.env.VITE_HONUA_REACT_SERVICE_ID,
  VITE_HONUA_REACT_WHERE: import.meta.env.VITE_HONUA_REACT_WHERE,
});

/** Root: wire a `HonuaClient` and shared selection state once, then render. */
export function App() {
  const client = useMemo(() => new HonuaClient({ baseUrl: config.baseUrl }), []);
  return (
    <HonuaProvider client={client}>
      <HonuaSelectionProvider onSelectionChange={(selected) => patchStatus({ selectedCount: selected.length })}>
        <Quickstart />
      </HonuaSelectionProvider>
    </HonuaProvider>
  );
}

/**
 * Create and own a plain `maplibre-gl` map — the external-map interop lane.
 * The app controls the map's lifecycle (exactly like `@vis.gl/react-maplibre`
 * would); Honua only mounts data onto it through `HonuaMapProvider` +
 * `HonuaSourceLayer`. StrictMode-safe: each effect run owns one map.
 */
function useExternalMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const created = new maplibregl.Map({
      container,
      style: BACKGROUND_STYLE,
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      attributionControl: false,
    });
    created.on("load", () => patchStatus({ mapReady: true }));
    setMap(created);
    return () => {
      setMap(null);
      created.remove();
    };
  }, []);

  return { containerRef, map };
}

function Quickstart() {
  const { containerRef, map } = useExternalMap();

  const descriptors = useMemo(() => buildDescriptors(config), []);
  const dataset = useDataset({ id: "react-quickstart", sources: descriptors, skipCompatibilityCheck: true });
  const source = useMemo(() => dataset.source(config.serviceId), [dataset]);
  const query = useMemo(() => ({ where: config.where, outFields: ["*"], returnGeometry: true }), []);

  const { data, isLoading, error } = useQuery(source, query);
  const caps = useCapabilities();

  useEffect(() => {
    if (data) patchStatus({ featureCount: data.features.length });
  }, [data]);
  useEffect(() => {
    if (caps.data) patchStatus({ serverVersion: caps.data.serverVersion });
  }, [caps.data]);
  useEffect(() => {
    if (error) patchStatus({ error: error instanceof Error ? error.message : String(error) });
  }, [error]);

  return (
    <div className="app-shell">
      <aside className="panel">
        <header>
          <p className="eyebrow">@honua/react</p>
          <h1>External map + bridge components</h1>
          <p className="lede">
            The app owns a plain <code>maplibre-gl</code> map (the <code>@vis.gl/react-maplibre</code> interop shape);{" "}
            <code>HonuaMapProvider</code> publishes it and <code>HonuaSourceLayer</code> mounts the queried source with
            a renderer prop. Selection is shared between map clicks and this sidebar via{" "}
            <code>HonuaSelectionProvider</code>.
          </p>
        </header>

        <dl className="status-grid">
          <div>
            <dt>Server</dt>
            <dd data-testid="server-version">
              {caps.isLoading ? "Checking…" : (caps.data?.serverVersion ?? "unknown")}
            </dd>
          </div>
          <div>
            <dt>Query state</dt>
            <dd data-testid="query-state">{error ? "error" : isLoading ? "loading" : "success"}</dd>
          </div>
          <div>
            <dt>Feature count</dt>
            <dd data-testid="feature-count">{data?.features.length ?? 0}</dd>
          </div>
        </dl>

        {error ? (
          <p className="error" data-testid="error-message">
            {error instanceof Error ? error.message : String(error)}
          </p>
        ) : null}

        <SelectionSummary />
        <FeatureList features={data?.features ?? []} />
      </aside>

      <section className="map-stage">
        <div ref={containerRef} className="map-canvas" data-honua-external-map="" />
        <HonuaMapProvider map={map}>
          <HonuaSourceLayer
            source={source}
            query={query}
            sourceId={QUICKSTART_SOURCE_ID}
            renderer={QUICKSTART_RENDERER}
            popup={{ factory: () => new maplibregl.Popup({ closeButton: false }), fields: ["NAME", "STATUS"] }}
            hover
            selection
            fitBounds={{ padding: 48 }}
            onError={(mountError) =>
              patchStatus({ error: mountError instanceof Error ? mountError.message : String(mountError) })
            }
          />
        </HonuaMapProvider>
      </section>
    </div>
  );
}

/** Non-map consumer of the shared selection state. */
function SelectionSummary() {
  const { selected, clear } = useSelection();
  return (
    <div className="selection-summary">
      <span data-testid="selection-count">
        {selected.length} selected{selected.length > 0 ? ` (#${selected.map((entry) => entry.id).join(", #")})` : ""}
      </span>
      {selected.length > 0 ? (
        <button type="button" data-testid="selection-clear" onClick={clear}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

/**
 * Sidebar list sharing selection/hover with the map: clicking a row toggles
 * the same selection a map click would, and the row highlights while its
 * feature is hovered on the map.
 */
function FeatureList({ features }: { features: ReadonlyArray<{ attributes: Record<string, unknown> }> }) {
  const { isSelected, toggle } = useSelection();
  const { hovered } = useHover();

  return (
    <ul className="feature-list" data-testid="feature-list">
      {features.map((feature, index) => {
        const attributes = feature.attributes;
        const rawId = attributes.OBJECTID;
        const id = typeof rawId === "number" || typeof rawId === "string" ? rawId : index + 1;
        const target = { sourceId: QUICKSTART_SOURCE_ID, id };
        const label = String(attributes.NAME ?? attributes.name ?? attributes.STATUS ?? `Feature ${index + 1}`);
        const selected = isSelected(target);
        const isHovered = hovered !== null && hovered.sourceId === target.sourceId && hovered.id === target.id;
        return (
          <li key={String(id)} className={isHovered ? "hovered" : undefined}>
            <button
              type="button"
              aria-pressed={selected}
              className={selected ? "feature-row selected" : "feature-row"}
              onClick={() => toggle(target)}
            >
              {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
