import { createHonua } from "@honua/sdk-js";
import type { ConnectProtocolHint, Source } from "@honua/sdk-js";
import { useMountedSource } from "@honua/sdk-js/react";
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
  readonly source: Source | null;
  readonly sourceId?: string;
  readonly protocol?: string;
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

/** Connect once per effect run and publish the discovered source. */
function useHonuaSource(): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ source: null });

  useEffect(() => {
    const honua = createHonua();
    let cancelled = false;
    void (async () => {
      try {
        const connection = await honua.connect(
          { url: ENDPOINT, protocol: PROTOCOL },
          { authorizationScopeFingerprint: "anonymous-public" },
        );
        const inspection = await connection.inspect();
        const sourceId = inspection.defaultSourceId ?? inspection.sources[0]?.descriptor.id;
        if (!sourceId) throw new Error("The endpoint advertised no queryable source.");
        if (cancelled) return;
        setState({ source: connection.source(sourceId), sourceId, protocol: inspection.protocol });
      } catch (error) {
        if (!cancelled) setState({ source: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
      void honua.dispose();
    };
  }, []);

  return state;
}

export function App() {
  const { containerRef, map } = useExternalMap();
  const connection = useHonuaSource();
  const mounted = useMountedSource(map, connection.source, { query: QUERY, fitBounds: true });

  const failure = connection.error ?? (mounted.error instanceof Error ? mounted.error.message : undefined);
  const status = failure
    ? `The workflow stopped: ${failure}`
    : mounted.handle
      ? "The queried source is mounted through the React bridge."
      : "Connecting, discovering, and mounting…";

  return (
    <main className="app">
      <section className="panel" aria-label="Workflow">
        <p className="eyebrow">Honua JavaScript SDK · React</p>
        <h1 className="title">connect → source → useMountedSource</h1>
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
            <dd>{mounted.diagnostics?.strategy ?? "—"}</dd>
          </div>
          <div>
            <dt>Features</dt>
            <dd id="fact-features">{mounted.diagnostics?.featureCount ?? "—"}</dd>
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
