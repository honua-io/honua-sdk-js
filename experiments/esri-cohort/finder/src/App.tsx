import * as maplibre from "maplibre-gl";
import type { ExpressionSpecification, FilterSpecification, Map as MapInstance } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { COLORS, field, loadData } from "./data.js";
import type { Venue } from "./data.js";

const VIEW = { center: [-118.12, 33.98] as [number, number], zoom: 8 };
const paletteFor = (names: string[]): ExpressionSpecification => [
  "coalesce",
  [
    "get",
    ["get", "cluster"],
    ["literal", Object.fromEntries(names.map((name, index) => [name, COLORS[index % COLORS.length]]))],
  ],
  "#888888",
];

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const popupRef = useRef<maplibre.Popup | null>(null);
  const chooseRef = useRef<(venue: Venue) => void>(() => {});
  const [venues, setVenues] = useState<Venue[]>([]);
  const [selected, setSelected] = useState<Venue | null>(null);
  const [search, setSearch] = useState("");
  const [descending, setDescending] = useState(false);
  const [clusters, setClusters] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("Loading venues and both distance buffers…");
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const [buffers, setBuffers] = useState(true);
  const categories = useMemo(() => [...new Set(venues.map((venue) => field(venue, "cluster")))].sort(), [venues]);
  const visible = useMemo(
    () =>
      venues
        .filter(
          (venue) =>
            (!clusters.length || clusters.includes(field(venue, "cluster"))) &&
            ["venue", "sports", "cluster"].some((name) =>
              field(venue, name).toLowerCase().includes(search.toLowerCase()),
            ),
        )
        .sort((a, b) => (descending ? -1 : 1) * field(a, "venue").localeCompare(field(b, "venue"))),
    [venues, clusters, search, descending],
  );
  const color = (category: string) => COLORS[categories.indexOf(category) % COLORS.length] ?? "#888888";
  chooseRef.current = (venue) => {
    setSelected(venue);
    if (venue.geometry.type === "Point" && mapRef.current) {
      const center = venue.geometry.coordinates as [number, number];
      mapRef.current.flyTo({ center, zoom: 17 });
      popupRef.current?.remove();
      popupRef.current = new maplibre.Popup({ closeButton: false })
        .setLngLat(center)
        .setText(field(venue, "venue"))
        .addTo(mapRef.current);
    }
  };

  useEffect(() => {
    if (!container.current) return;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(60_000)]);
    const timing = `finder-load-${reload}`;
    performance.mark(timing);
    const map = new maplibre.Map({
      container: container.current,
      style: import.meta.env.VITE_BASEMAP_STYLE || "https://tiles.openfreemap.org/styles/liberty",
      ...VIEW,
    });
    mapRef.current = map;
    setReady(false);
    setError("");
    setSelected(null);
    map.addControl(new maplibre.NavigationControl(), "top-left");
    map.on("error", (event) => {
      if (!cancellation.signal.aborted) setError(event.error.message);
    });
    void (async () => {
      try {
        const loaded = new Promise<void>((resolve, reject) => {
          const abort = () => {
            map.off("load", onLoad);
            reject(signal.reason);
          };
          const onLoad = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          signal.addEventListener("abort", abort, { once: true });
          map.once("load", onLoad);
        });
        const [data] = await Promise.all([loadData(signal, setProgress), loaded]);
        if (cancellation.signal.aborted) return;
        const points = data[0].features;
        if (points.some((venue) => venue.geometry.type !== "Point"))
          throw new Error("Venue layer contains non-point geometry");
        for (const venue of points) {
          if (venue.geometry.type !== "Point") continue;
          const [x, y] = venue.geometry.coordinates;
          if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90)
            throw new Error("Venue geometry is not valid WGS84; inspect the import CRS");
        }
        const names = [...new Set(points.map((venue) => field(venue, "cluster")))].sort();
        const palette: ExpressionSpecification = paletteFor(names);
        for (const index of [2, 1]) {
          const id = `buffer-${index}`;
          map.addSource(id, { type: "geojson", data: data[index] });
          map.addLayer({
            id,
            type: "fill",
            source: id,
            paint: {
              "fill-color": "#8574aa",
              "fill-opacity": index === 1 ? 0.12 : 0.06,
              "fill-outline-color": "#9387ac",
            },
          });
        }
        map.addSource("venues", { type: "geojson", data: data[0], promoteId: "__honua_id" });
        map.addLayer({
          id: "venue-glow",
          type: "circle",
          source: "venues",
          paint: { "circle-color": "#ffff90", "circle-radius": 18, "circle-blur": 0.6, "circle-opacity": 0 },
          filter: ["==", ["id"], ""],
        });
        map.addLayer({
          id: "venues",
          type: "circle",
          source: "venues",
          paint: {
            "circle-color": palette,
            "circle-radius": 7,
            "circle-stroke-color": "white",
            "circle-stroke-width": 1.5,
          },
        });
        map.on("click", "venues", (event) => {
          const id = event.features?.[0]?.id;
          const venue = points.find((point) => String(point.id) === String(id));
          if (venue) chooseRef.current(venue);
        });
        map.on("mouseenter", "venues", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "venues", () => {
          map.getCanvas().style.cursor = "";
        });
        setVenues(points);
        setReady(true);
        performance.measure(timing, timing);
      } catch (failure) {
        if (!cancellation.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => {
      cancellation.abort();
      popupRef.current?.remove();
      popupRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [reload]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const match: FilterSpecification = selected
      ? ["==", ["id"], selected.id as string]
      : clusters.length
        ? ["in", ["get", "cluster"], ["literal", clusters]]
        : ["literal", true];
    const palette: ExpressionSpecification = paletteFor(categories);
    map.setPaintProperty("venues", "circle-color", ["case", match, palette, "#888888"]);
    map.setPaintProperty("venues", "circle-opacity", ["case", match, 1, 0.3]);
    map.setPaintProperty("venues", "circle-stroke-opacity", ["case", match, 1, 0.3]);
    map.setFilter("venue-glow", selected ? ["==", ["id"], selected.id as string] : ["==", ["id"], ""]);
    map.setPaintProperty("venue-glow", "circle-opacity", selected ? 0.85 : 0);
    for (const id of ["buffer-1", "buffer-2"]) map.setLayoutProperty(id, "visibility", buffers ? "visible" : "none");
  }, [ready, selected, clusters, categories, buffers]);

  const back = () => {
    popupRef.current?.remove();
    popupRef.current = null;
    setSelected(null);
    mapRef.current?.flyTo(VIEW);
  };
  return (
    <main>
      <header>
        <span>LA Olympics 2028</span>
        <span className="brand">Honua venue finder</span>
      </header>
      <aside aria-label="Venues">
        {error && (
          <div role="alert">
            {error}
            <button type="button" onClick={() => setReload((value) => value + 1)}>
              Retry
            </button>
          </div>
        )}
        {!ready && !error && <output>{progress}</output>}
        {selected ? (
          <section aria-label="Venue details">
            <button type="button" onClick={back}>
              ← Back to venues
            </button>
            <h1>{field(selected, "venue")}</h1>
            <p>{field(selected, "sports")}</p>
            <h2>Location</h2>
            <p>
              <i style={{ background: color(field(selected, "cluster")) }} />
              {field(selected, "cluster")}
            </p>
            {selected.geometry.type === "Point" && (
              <p>
                Latitude {selected.geometry.coordinates[1].toFixed(5)}
                <br />
                Longitude {selected.geometry.coordinates[0].toFixed(5)}
              </p>
            )}
            <h2>Building status</h2>
            <p>{field(selected, "status") || "Not provided"}</p>
          </section>
        ) : (
          <>
            <h1>Venues</h1>
            <fieldset>
              <legend>Clusters</legend>
              {categories.map((category) => (
                <label key={category}>
                  <input
                    type="checkbox"
                    checked={clusters.includes(category)}
                    onChange={() =>
                      setClusters((values) =>
                        values.includes(category)
                          ? values.filter((value) => value !== category)
                          : [...values, category],
                      )
                    }
                  />
                  <i style={{ background: color(category) }} />
                  {category}
                </label>
              ))}
            </fieldset>
            <div className="search">
              <input
                aria-label="Filter venues"
                placeholder="Filter venues…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                ×
              </button>
              <button
                type="button"
                aria-label={descending ? "Sort ascending" : "Sort descending"}
                onClick={() => setDescending((value) => !value)}
              >
                {descending ? "Z–A" : "A–Z"}
              </button>
            </div>
            <output aria-live="polite">
              {visible.length} of {venues.length} venues
            </output>
            <ul>
              {visible.map((venue) => (
                <li key={venue.id}>
                  <button type="button" onClick={() => chooseRef.current(venue)}>
                    <strong>{field(venue, "venue")}</strong>
                    <span>{field(venue, "sports")}</span>
                    <small>
                      <i style={{ background: color(field(venue, "cluster")) }} />
                      {field(venue, "cluster")}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {ready && !visible.length && <p>No matching venues.</p>}
          </>
        )}
      </aside>
      <div ref={container} className="map" role="application" aria-label="Venue map" />
      <details className="legend">
        <summary>Legend</summary>
        {categories.map((category) => (
          <p key={category}>
            <i style={{ background: color(category) }} />
            {category}
          </p>
        ))}
        <label>
          <input type="checkbox" checked={buffers} onChange={(event) => setBuffers(event.target.checked)} />
          2-mile and 5-mile buffers
        </label>
      </details>
    </main>
  );
}
