import { createHonua } from "@honua/sdk-js";
import type { ConnectProtocolHint, RendererDiagnostic } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { FIXTURE_LAYER_PATH } from "./fixture-endpoint.js";

/** Offline basemap: the starter never fetches third-party tiles on its default lane. */
const BASEMAP_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [{ id: "background", type: "background" as const, paint: { "background-color": "#0e1a17" } }],
};

const INITIAL_VIEW = { center: [-157.873, 21.2985] as [number, number], zoom: 11.4 };

/** Bounded row budget. The bridge reports truncation instead of hiding it. */
const MAX_FEATURES = 250;

const QUERY = { returnGeometry: true, pagination: { limit: MAX_FEATURES } };

const configuredEndpoint = import.meta.env.VITE_HONUA_ENDPOINT?.trim();
const configuredProtocol = import.meta.env.VITE_HONUA_PROTOCOL?.trim();

const ENDPOINT =
  configuredEndpoint && configuredEndpoint.length > 0
    ? configuredEndpoint
    : new URL(FIXTURE_LAYER_PATH, window.location.origin).toString();
const PROTOCOL = (
  configuredProtocol && configuredProtocol.length > 0 ? configuredProtocol : "geoservices-feature-service"
) as ConnectProtocolHint;
const DATA_LANE = configuredEndpoint && configuredEndpoint.length > 0 ? "Live endpoint" : "Committed fixture";

interface ConnectionState {
  readonly sourceId?: string;
  readonly protocol?: string;
  readonly diagnostics?: readonly RendererDiagnostic[];
  readonly featureCount?: number;
  readonly mounted: boolean;
  readonly error?: string;
}

/** The app owns its MapLibre map, exactly like a `@vis.gl/react-maplibre` `<Map>` would. */
function useExternalMap(): { containerRef: RefObject<HTMLDivElement | null>; map: maplibregl.Map | null } {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const created = new maplibregl.Map({
      container,
      style: BASEMAP_STYLE,
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      attributionControl: false,
    });
    setMap(created);
    return () => {
      setMap(null);
      created.remove();
    };
  }, []);

  return { containerRef, map };
}

/** Run the canonical kernel-owned lifecycle against the app-owned map. */
function useHonuaMap(map: maplibregl.Map | null): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ mounted: false });

  useEffect(() => {
    if (!map) return;
    const honua = createHonua();
    const cancellation = new AbortController();
    void (async () => {
      try {
        const connection = await honua.connect(
          { url: ENDPOINT, protocol: PROTOCOL },
          { authorizationScopeFingerprint: "anonymous-public", signal: cancellation.signal },
        );
        const inspection = await connection.inspect({ signal: cancellation.signal });
        const sourceId = inspection.defaultSourceId ?? inspection.sources[0]?.descriptor.id;
        if (!sourceId) throw new Error("The endpoint advertised no queryable source.");
        const plan = await connection.explain(QUERY, { sourceId, signal: cancellation.signal });
        const result = await connection.query(plan, { signal: cancellation.signal });
        const mounted = await connection.mount(map, {
          renderer: maplibreRenderer(maplibregl),
          query: plan,
          sourceId,
          signal: cancellation.signal,
        });
        await mounted.ready;
        setState({
          sourceId,
          protocol: inspection.protocol,
          diagnostics: mounted.diagnostics,
          featureCount: result.execution.terminal.featureCount,
          mounted: true,
        });
      } catch (error) {
        if (!cancellation.signal.aborted) {
          setState({ mounted: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancellation.abort();
      void honua.dispose();
    };
  }, [map]);

  return state;
}

export function App() {
  const { containerRef, map } = useExternalMap();
  const connection = useHonuaMap(map);

  const status = connection.error
    ? `The workflow stopped: ${connection.error}`
    : connection.mounted
      ? "The accepted plan is mounted through the kernel lifecycle."
      : "Connecting, discovering, and mounting…";

  return (
    <main className="app">
      <section className="panel" aria-label="Workflow">
        <p className="eyebrow">Honua JavaScript SDK · React</p>
        <h1 className="title">connect → inspect → explain → query → mount</h1>
        <output className="status" aria-live="polite">
          {status}
        </output>
        <dl className="facts">
          <div>
            <dt>Data lane</dt>
            <dd>{DATA_LANE}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>{ENDPOINT}</dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>{connection.protocol ?? "—"}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{connection.sourceId ?? "—"}</dd>
          </div>
          <div>
            <dt>Strategy</dt>
            <dd>{connection.diagnostics?.find((item) => item.strategy)?.strategy ?? "—"}</dd>
          </div>
          <div>
            <dt>Features</dt>
            <dd id="fact-features">{connection.featureCount ?? "—"}</dd>
          </div>
        </dl>
        <p className="hint">
          Edit <code>src/App.tsx</code> to change the query, or set <code>VITE_HONUA_ENDPOINT</code> to run the same
          components against a live public service.
        </p>
      </section>
      <div className="map" ref={containerRef} role="application" aria-label="Mounted map" />
    </main>
  );
}
