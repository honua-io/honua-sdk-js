import {
  addDataToMap,
  setAnimationConfig,
  setFilter,
  wrapTo,
} from "@kepler.gl/actions";
import { KeplerGl } from "@kepler.gl/components";
import { processGeojson } from "@kepler.gl/processors";
import { useEffect, useMemo, useRef, useState } from "react";

import keplerConfig from "./config/kepler-config.json";
import { store } from "./store";

const DEMO_ID = "ops-replay";
const PUBLIC_STYLE_ID = "honua_ops_public";
const DEFAULT_STYLE_URL = "https://demotiles.maplibre.org/style.json";
const REPLAY_FILTER_ID = "replay-window-filter";
const REPLAY_FILTER_DATASETS = ["incidents", "unit-tracks"] as const;
const REPLAY_TIME_FIELD = "replay_at";
const STYLE_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#11243d" />
          <stop offset="100%" stop-color="#296264" />
        </linearGradient>
      </defs>
      <rect width="160" height="90" rx="16" fill="url(#bg)" />
      <path d="M12 64 C40 38, 74 36, 148 20" stroke="#f8f1d1" stroke-width="6" fill="none" opacity="0.9" />
      <circle cx="54" cy="42" r="7" fill="#ffa65b" />
      <circle cx="107" cy="29" r="7" fill="#ff5d5d" />
    </svg>`,
  );

interface FixtureMetadata {
  storyId: string;
  storyTitle: string;
  storySubtitle: string;
  modeLabel: string;
  exportedAt: string;
  sourceEnvironment: string;
  timeWindow: {
    start: string;
    end: string;
    label: string;
  };
  datasets: Array<{
    id: string;
    label: string;
    path: string;
    recordCount: number;
    source: {
      serviceId: string;
      layerId: number;
      endpoint: string;
      description: string;
      envServiceId: string;
      envLayerId: string;
      timeField?: string;
    };
  }>;
  walkthrough: Array<{
    title: string;
    detail: string;
  }>;
  kpis: Array<{
    id: string;
    label: string;
    value: string;
    detail: string;
  }>;
  provenance: {
    badge: string;
    summary: string;
    derivationNotes: string[];
    refreshCommand: string;
  };
}

interface DemoDataset {
  info: {
    id: string;
    label: string;
  };
  data: Exclude<ReturnType<typeof processGeojson>, null>;
}

interface GeoJsonFeatureCollection {
  features?: Array<{
    properties?: Record<string, unknown> | null;
  }>;
}

type ReplayDatasetId = (typeof REPLAY_FILTER_DATASETS)[number];

interface ReplayHarnessState {
  currentTime: number | null;
  dataIds: string[];
  filteredCounts: Record<ReplayDatasetId, number>;
  layerIds: string[];
  replayStatus: Record<ReplayDatasetId, string | null>;
  value: [number, number] | null;
}

interface ReplayHarness {
  getReplayState: () => ReplayHarnessState | null;
  setReplayWindow: (startIso: string, endIso: string) => boolean;
}

type KeplerAnalyticsWindow = Window & {
  __keplerAnalyticsError?: string | null;
  __keplerAnalyticsHarness?: ReplayHarness;
  __keplerAnalyticsReady?: boolean;
};

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseFixtureTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid fixture ${label}: ${value}`);
  }
  return parsed;
}

function resolveReplayWindow(startIso: string, endIso: string) {
  const start = parseFixtureTime(startIso, "timeWindow.start");
  const end = parseFixtureTime(endIso, "timeWindow.end");

  if (end < start) {
    throw new Error(`Invalid fixture replay window: ${startIso} -> ${endIso}`);
  }

  return {
    start,
    end,
    currentTime: start + Math.round((end - start) / 2),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function loadFixtureBundle(): Promise<{
  metadata: FixtureMetadata;
  datasets: DemoDataset[];
  replayWindow: {
    start: string;
    end: string;
  };
}> {
  const metadata = await fetchJson<FixtureMetadata>("/data/fixture-metadata.json");
  const replayTimestamps: number[] = [];
  const datasets = await Promise.all(
    metadata.datasets.map(async (dataset) => {
      const rawDataset = await fetchJson<GeoJsonFeatureCollection>(dataset.path);
      if ((REPLAY_FILTER_DATASETS as readonly string[]).includes(dataset.id)) {
        for (const feature of rawDataset.features ?? []) {
          const replayAt = feature.properties?.[REPLAY_TIME_FIELD];
          if (typeof replayAt === "string") {
            const timestamp = Date.parse(replayAt);
            if (Number.isFinite(timestamp)) {
              replayTimestamps.push(timestamp);
            }
          }
        }
      }

      const processed = processGeojson(rawDataset);
      if (!processed) {
        throw new Error(`Failed to process fixture dataset ${dataset.id}.`);
      }

      return {
        info: {
          id: dataset.id,
          label: dataset.label,
        },
        data: processed,
      };
    }),
  );

  const replayWindow =
    replayTimestamps.length > 0
      ? {
          start: new Date(Math.min(...replayTimestamps)).toISOString(),
          end: new Date(Math.max(...replayTimestamps)).toISOString(),
        }
      : {
          start: metadata.timeWindow.start,
          end: metadata.timeWindow.end,
        };

  return { metadata, datasets, replayWindow };
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 760 });

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }

    const updateSize = () => {
      const width = Math.max(360, Math.round(node.clientWidth));
      const height = Math.max(420, Math.round(node.clientHeight));
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

function cloneConfig(): any {
  return JSON.parse(JSON.stringify(keplerConfig.config)) as any;
}

function applyReplayWindowToConfig(config: any, replayWindowConfig: { start: string; end: string }): any {
  const replayWindow = resolveReplayWindow(replayWindowConfig.start, replayWindowConfig.end);

  config.visState.filters = config.visState.filters.map((filter: any) =>
    filter.id === REPLAY_FILTER_ID
      ? {
          ...filter,
          dataId: [...REPLAY_FILTER_DATASETS],
          name: [REPLAY_TIME_FIELD, REPLAY_TIME_FIELD],
          value: [replayWindow.start, replayWindow.end],
        }
      : filter,
  );
  config.visState.animationConfig = {
    ...config.visState.animationConfig,
    currentTime: replayWindow.currentTime,
  };

  return config;
}

function getDemoState() {
  return (store.getState() as any).keplerGl?.[DEMO_ID] ?? null;
}

function getReplayFilter() {
  return getDemoState()?.visState?.filters.find((filter: any) => filter.id === REPLAY_FILTER_ID) ?? null;
}

function getDatasetFilterDataIds(filter: any): string[] {
  if (Array.isArray(filter?.dataId)) {
    return filter.dataId.filter((dataId: unknown): dataId is string => typeof dataId === "string");
  }
  return typeof filter?.dataId === "string" ? [filter.dataId] : [];
}

function getDatasetFilterFieldIndex(dataset: any, dataId: string, filter: any): number {
  const dataIds = getDatasetFilterDataIds(filter);
  const datasetIndex = dataIds.indexOf(dataId);
  if (datasetIndex < 0) {
    return -1;
  }

  const fieldIndexes = Array.isArray(filter?.fieldIdx) ? filter.fieldIdx : [filter?.fieldIdx];
  const resolvedFieldIndex = fieldIndexes[datasetIndex] ?? fieldIndexes[0];
  if (typeof resolvedFieldIndex === "number") {
    return resolvedFieldIndex;
  }

  const fieldNames = Array.isArray(filter?.name) ? filter.name : [filter?.name];
  const resolvedFieldName = fieldNames[datasetIndex] ?? fieldNames[0];
  if (typeof resolvedFieldName !== "string") {
    return -1;
  }

  return dataset.fields?.findIndex((field: any) => field.name === resolvedFieldName) ?? -1;
}

function datasetRowMatchesFilter(dataset: any, dataId: string, rowIndex: number, filter: any): boolean {
  const fieldIndex = getDatasetFilterFieldIndex(dataset, dataId, filter);
  if (fieldIndex < 0 || typeof dataset?.dataContainer?.valueAt !== "function") {
    return true;
  }

  const fieldValue = dataset.dataContainer.valueAt(rowIndex, fieldIndex);

  switch (filter?.type) {
    case "multiSelect": {
      const selectedValues = Array.isArray(filter.value) ? filter.value : [];
      return selectedValues.length === 0 || selectedValues.includes(fieldValue);
    }
    case "select":
      return fieldValue === filter.value;
    case "range": {
      if (!Array.isArray(filter.value) || filter.value.length < 2) {
        return true;
      }

      const [minValue, maxValue] = filter.value.map(Number);
      const numericValue = Number(fieldValue);
      return (
        Number.isFinite(minValue) &&
        Number.isFinite(maxValue) &&
        Number.isFinite(numericValue) &&
        numericValue >= minValue &&
        numericValue <= maxValue
      );
    }
    case "timeRange": {
      if (!Array.isArray(filter.value) || filter.value.length < 2) {
        return true;
      }

      const [start, end] = filter.value.map(Number);
      const timestamp =
        typeof fieldValue === "number" ? fieldValue : Date.parse(typeof fieldValue === "string" ? fieldValue : "");

      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        Number.isFinite(timestamp) &&
        timestamp >= start &&
        timestamp <= end
      );
    }
    default:
      return true;
  }
}

function getDatasetRowCount(dataset: any): number {
  const rowCountValue = dataset?.dataContainer?.numRows;
  if (typeof rowCountValue === "function") {
    const computedRowCount = rowCountValue.call(dataset.dataContainer);
    return typeof computedRowCount === "number" ? computedRowCount : 0;
  }
  if (typeof rowCountValue === "number") {
    return rowCountValue;
  }
  return dataset?.allIndexes?.length ?? 0;
}

function getDatasetFilteredCount(demoState: any, dataId: ReplayDatasetId): number {
  const dataset = demoState?.visState?.datasets?.[dataId];
  const rowCount = getDatasetRowCount(dataset);
  if (!dataset || typeof rowCount !== "number" || rowCount <= 0) {
    return 0;
  }

  const activeFilters = demoState.visState.filters.filter(
    (filter: any) => filter?.enabled !== false && getDatasetFilterDataIds(filter).includes(dataId),
  );
  if (activeFilters.length === 0) {
    return rowCount;
  }

  let filteredCount = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    if (activeFilters.every((filter: any) => datasetRowMatchesFilter(dataset, dataId, rowIndex, filter))) {
      filteredCount += 1;
    }
  }

  return filteredCount;
}

function getReplayHarnessState(): ReplayHarnessState | null {
  const demoState = getDemoState();
  const replayFilter = getReplayFilter();

  if (!demoState?.visState || !replayFilter) {
    return null;
  }

  const filteredCounts = {} as Record<ReplayDatasetId, number>;
  const replayStatus = {} as Record<ReplayDatasetId, string | null>;
  for (const dataId of REPLAY_FILTER_DATASETS) {
    filteredCounts[dataId] = getDatasetFilteredCount(demoState, dataId);
    replayStatus[dataId] =
      demoState.visState.datasets[dataId]?.changedFilters?.fixedDomain?.[REPLAY_FILTER_ID] ?? null;
  }

  const dataIds = Array.isArray(replayFilter.dataId) ? replayFilter.dataId : [replayFilter.dataId];
  const value =
    Array.isArray(replayFilter.value) && replayFilter.value.length >= 2
      ? ([replayFilter.value[0], replayFilter.value[1]] as [number, number])
      : null;

  return {
    currentTime: demoState.visState.animationConfig.currentTime ?? null,
    dataIds,
    filteredCounts,
    layerIds: demoState.visState.layers.map((layer: any) => layer.id),
    replayStatus,
    value,
  };
}

function setReplayWindowFromHarness(startIso: string, endIso: string): boolean {
  const demoState = getDemoState();
  if (!demoState?.visState) {
    return false;
  }

  const filterIndex = demoState.visState.filters.findIndex((filter: any) => filter.id === REPLAY_FILTER_ID);
  if (filterIndex < 0) {
    return false;
  }

  const replayWindow = resolveReplayWindow(startIso, endIso);
  store.dispatch(wrapTo(DEMO_ID, setFilter(filterIndex, "value", [replayWindow.start, replayWindow.end])));
  store.dispatch(
    wrapTo(
      DEMO_ID,
      setAnimationConfig({
        currentTime: replayWindow.currentTime,
      } as any),
    ),
  );

  return true;
}

export function App() {
  const [metadata, setMetadata] = useState<FixtureMetadata | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [mapRootRef, size] = useElementSize<HTMLDivElement>();
  const hasLoadedRef = useRef(false);

  const useMapboxDefaults =
    import.meta.env.VITE_KEPLER_USE_MAPBOX_DEFAULTS === "true" &&
    typeof import.meta.env.VITE_MAPBOX_TOKEN === "string" &&
    import.meta.env.VITE_MAPBOX_TOKEN.trim() !== "";

  const publicStyleUrl = import.meta.env.VITE_KEPLER_STYLE_URL?.trim() || DEFAULT_STYLE_URL;
  const customMapStyles = useMemo(
    () =>
      useMapboxDefaults
        ? []
        : [
            {
              id: PUBLIC_STYLE_ID,
              label: "Honua Ops Streets",
              url: publicStyleUrl,
              icon: STYLE_ICON,
            },
          ],
    [publicStyleUrl, useMapboxDefaults],
  );

  useEffect(() => {
    if (hasLoadedRef.current) {
      return;
    }

    hasLoadedRef.current = true;

    void (async () => {
      try {
        const bundle = await loadFixtureBundle();
        const resolvedConfig = applyReplayWindowToConfig(cloneConfig(), bundle.replayWindow);

        resolvedConfig.mapStyle.styleType = useMapboxDefaults ? "dark" : PUBLIC_STYLE_ID;

        store.dispatch(
          wrapTo(
            DEMO_ID,
            addDataToMap({
              datasets: bundle.datasets,
              options: {
                centerMap: false,
                readOnly: false,
              },
              config: resolvedConfig as any,
            }),
          ),
        );

        setMetadata(bundle.metadata);
        setStatus("ready");
      } catch (error) {
        setErrorMessage(describeError(error));
        setStatus("error");
      }
    })();
  }, [useMapboxDefaults]);

  useEffect(() => {
    const windowState = window as KeplerAnalyticsWindow;

    windowState.__keplerAnalyticsReady = status === "ready";
    windowState.__keplerAnalyticsError = status === "error" ? errorMessage : null;
    if (status === "ready") {
      windowState.__keplerAnalyticsHarness = {
        getReplayState: getReplayHarnessState,
        setReplayWindow: setReplayWindowFromHarness,
      };
      return;
    }

    delete windowState.__keplerAnalyticsHarness;
  }, [errorMessage, status]);

  return (
    <div className="app-shell">
      <aside className="insight-rail">
        <div className="eyebrow-row">
          <span className="eyebrow">Portfolio Demo</span>
          <span className="eyebrow subdued" data-testid="fixture-provenance">
            {metadata?.provenance.badge ?? "Loading fixture"}
          </span>
        </div>

        <header className="hero-copy">
          <h1 data-testid="demo-title">{metadata?.storyTitle ?? "Operations replay loading"}</h1>
          <p>{metadata?.storySubtitle ?? "Preparing the committed Honua fixture bundle."}</p>
        </header>

        <section className="panel">
          <div className="panel-heading">
            <h2>Walkthrough</h2>
            <span>{metadata?.timeWindow.label ?? "Preparing replay window"}</span>
          </div>
          <ol className="walkthrough-list">
            {(metadata?.walkthrough ?? []).map((step, index) => (
              <li key={step.title} data-testid={`walkthrough-step-${index + 1}`}>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>Signal Cards</h2>
            <span>Precomputed from the exported fixture</span>
          </div>
          <div className="kpi-grid">
            {(metadata?.kpis ?? []).map((kpi) => (
              <article className="kpi-card" data-testid={`kpi-${kpi.id}`} key={kpi.id}>
                <span className="kpi-label">{kpi.label}</span>
                <strong>{kpi.value}</strong>
                <p>{kpi.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>Data Provenance</h2>
            <span>{metadata ? new Date(metadata.exportedAt).toLocaleString() : "Pending"}</span>
          </div>
          <p className="panel-copy">{metadata?.provenance.summary}</p>
          <div className="dataset-list">
            {(metadata?.datasets ?? []).map((dataset) => (
              <article className="dataset-card" data-testid={`dataset-${dataset.id}`} key={dataset.id}>
                <div>
                  <strong>{dataset.label}</strong>
                  <span>
                    {dataset.recordCount} records from {dataset.source.serviceId}/{dataset.source.layerId}
                  </span>
                </div>
                <small>{dataset.source.description}</small>
              </article>
            ))}
          </div>
          <ul className="notes-list">
            {(metadata?.provenance.derivationNotes ?? []).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <code className="refresh-command">{metadata?.provenance.refreshCommand ?? ""}</code>
        </section>
      </aside>

      <section className="map-panel">
        <div className="map-chrome">
          <div>
            <span className="panel-kicker">{metadata?.modeLabel ?? "Fixture mode"}</span>
            <strong>{metadata?.sourceEnvironment ?? "Local deterministic export"}</strong>
          </div>
          <div className="status-stack">
            {status === "loading" ? <span className="status-chip">Loading replay fixture</span> : null}
            {status === "ready" ? (
              <span className="status-chip ready" data-testid="demo-ready">
                Replay ready
              </span>
            ) : null}
            {status === "error" ? <span className="status-chip error">{errorMessage}</span> : null}
          </div>
        </div>

        <div className="map-root" data-testid="kepler-map" ref={mapRootRef}>
          <KeplerGl
            id={DEMO_ID}
            appName="Honua Replay Lab"
            version="fixture-mode"
            width={size.width}
            height={size.height}
            theme="light"
            mapStyles={customMapStyles}
            mapStylesReplaceDefault={!useMapboxDefaults}
            mapboxApiAccessToken={import.meta.env.VITE_MAPBOX_TOKEN}
          />
        </div>
      </section>
    </div>
  );
}
