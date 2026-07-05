import { useEffect, useMemo } from "react";

import { HonuaClient } from "@honua/sdk-js/honua";
import {
  HonuaLayer,
  HonuaMap,
  HonuaPopup,
  HonuaProvider,
  useCapabilities,
  useDataset,
  useQuery,
} from "@honua/sdk-js/react";
import type { HonuaMapRuntime, RuntimeLayerSpecification, RuntimeSourceSpecification } from "@honua/sdk-js/runtime";

import { resolveReactQuickstartConfig } from "./config.js";
import { QUICKSTART_MAP_PACKAGE, SITES_GEOJSON, buildDescriptors } from "./data.js";

declare global {
  interface Window {
    __HONUA_REACT_QUICKSTART__?: {
      mapReady?: boolean;
      featureCount?: number;
      serverVersion?: string;
      error?: string | null;
    };
  }
}

function patchStatus(patch: NonNullable<Window["__HONUA_REACT_QUICKSTART__"]>): void {
  window.__HONUA_REACT_QUICKSTART__ = { ...(window.__HONUA_REACT_QUICKSTART__ ?? {}), ...patch };
}

const config = resolveReactQuickstartConfig(import.meta.env as Record<string, string | undefined>);

const SITES_SOURCE: RuntimeSourceSpecification = { type: "geojson", data: SITES_GEOJSON } as RuntimeSourceSpecification;
const SITES_LAYER: RuntimeLayerSpecification = {
  id: "sites-circles",
  type: "circle",
  source: "sites",
  paint: {
    "circle-radius": 8,
    "circle-color": "#38bdf8",
    "circle-stroke-width": 2,
    "circle-stroke-color": "#0b1021",
  },
} as RuntimeLayerSpecification;

/** Root: wire a `HonuaClient` into the provider once, then render the app. */
export function App() {
  const client = useMemo(() => new HonuaClient({ baseUrl: config.baseUrl }), []);
  return (
    <HonuaProvider client={client}>
      <Quickstart />
    </HonuaProvider>
  );
}

function Quickstart() {
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

  const handleRuntime = (_runtime: HonuaMapRuntime) => patchStatus({ mapReady: true });
  const handleError = (mapError: unknown) =>
    patchStatus({ error: mapError instanceof Error ? mapError.message : String(mapError) });

  return (
    <div className="app-shell">
      <aside className="panel">
        <header>
          <p className="eyebrow">@honua/react</p>
          <h1>Provider + hooks + map components</h1>
          <p className="lede">
            <code>useDataset</code> + <code>useQuery</code> drive the data panel; <code>HonuaMap</code> owns the runtime
            with declarative <code>HonuaLayer</code> / <code>HonuaPopup</code> children.
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

        <ul className="feature-list" data-testid="feature-list">
          {(data?.features ?? []).map((feature, index) => {
            const attributes = feature.attributes as Record<string, unknown>;
            const label = String(attributes.NAME ?? attributes.name ?? attributes.STATUS ?? `Feature ${index + 1}`);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixture rows are positional and stable.
              <li key={index}>{label}</li>
            );
          })}
        </ul>
      </aside>

      <section className="map-stage">
        <HonuaMap
          package={QUICKSTART_MAP_PACKAGE}
          className="map-canvas"
          onRuntime={handleRuntime}
          onError={handleError}
        >
          <HonuaLayer source={{ id: "sites", spec: SITES_SOURCE }} layer={SITES_LAYER} />
          <HonuaPopup layer="sites-circles" binding={{ sourceId: "sites", title: "Site", fieldName: "name" }} />
        </HonuaMap>
      </section>
    </div>
  );
}
