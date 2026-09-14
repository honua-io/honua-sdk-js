import { envelope } from "@honua/sdk-js";
import type { Query } from "@honua/sdk-js/contract";
import type { Geometry, MultiLineString } from "geojson";
import { Map as LibreMap, NavigationControl, Popup } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlightChart } from "./FlightChart.js";
import { FlightRecords } from "./FlightRecords.js";
import { FLIGHT_SPEED_STOPS, flightSpeedColor } from "./cartography.js";
import {
  EMPTY,
  aggregate,
  complaintHighlightQuery,
  connectCohort,
  dayQuery,
  field,
  halfMileAround,
  label,
  loadFeatures,
  matchingIds,
  neighborhoodStats,
  nextDay,
  renderable,
  value,
} from "./data.js";
import type { Attributes, Cohort, Collection, MapFeature } from "./data.js";

const number = (input: unknown) =>
  input == null ? "—" : Number(input).toLocaleString("en-US", { maximumFractionDigits: 0 });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
const time = (input: unknown) => {
  const date = new Date(typeof input === "number" ? input : String(input));
  return Number.isFinite(date.getTime()) ? clock.format(date) : "Unknown time";
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function tracksGeometry(features: MapFeature[]): MultiLineString | null {
  const coordinates = features.flatMap((feature) =>
    feature.geometry?.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry?.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [],
  );
  return coordinates.length ? { type: "MultiLineString", coordinates } : null;
}

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const clickRef = useRef<(id: string) => void>(() => {});
  const loupeRef = useRef<(geometry: Geometry) => void>(() => {});
  const pointerFrame = useRef(0);
  const pointerGeometry = useRef<Geometry | null>(null);
  const [cohort, setCohort] = useState<Cohort | null>(null);
  const [days, setDays] = useState<{ day: string; count: number }[]>([]);
  const [day, setDay] = useState("");
  const [flights, setFlights] = useState<Collection>(EMPTY);
  const [complaints, setComplaints] = useState<Collection>(EMPTY);
  const [dayComplaints, setDayComplaints] = useState<Collection>(EMPTY);
  const [highlightedIds, setHighlightedIds] = useState<string[] | null>(null);
  const [aircraftRows, setAircraftRows] = useState<Attributes[]>([]);
  const [aircraft, setAircraft] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showFlights, setShowFlights] = useState(true);
  const [showComplaints, setShowComplaints] = useState(true);
  const [showSummary, setShowSummary] = useState(false);
  const [extentOnly, setExtentOnly] = useState(true);
  const [mapBounds, setMapBounds] = useState<Query["spatialFilter"]>();
  const [loupe, setLoupe] = useState(false);
  const [probe, setProbe] = useState<Geometry | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof neighborhoodStats>> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("Connecting to imported helicopter data…");
  const [complaintLoading, setComplaintLoading] = useState(false);
  const [highlightLoading, setHighlightLoading] = useState(false);
  const [retry, setRetry] = useState(0);

  const aircraftFlights = useMemo(
    () => (aircraft ? flights.features.filter((feature) => label(feature.properties, "r") === aircraft) : []),
    [flights, aircraft],
  );
  const selectedFlights = useMemo(() => {
    const selected = new Set(selectedIds);
    return flights.features.filter((feature) => selected.has(String(feature.id)));
  }, [flights, selectedIds]);
  const selectedGeometry = useMemo(
    () => tracksGeometry(selectedFlights.length ? selectedFlights : aircraftFlights),
    [selectedFlights, aircraftFlights],
  );
  clickRef.current = (id) => {
    const flight = flights.features.find((feature) => String(feature.id) === id);
    if (flight) {
      setAircraft(label(flight.properties, "r"));
      setSelectedIds([id]);
    }
  };
  loupeRef.current = (geometry) => {
    if (!loupe) return;
    pointerGeometry.current = geometry;
    if (!pointerFrame.current)
      pointerFrame.current = requestAnimationFrame(() => {
        pointerFrame.current = 0;
        setProbe(pointerGeometry.current);
      });
  };

  useEffect(() => {
    if (!container.current) return;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(120_000)]);
    let session: Cohort | undefined;
    const map = new LibreMap({
      container: container.current,
      style: import.meta.env.VITE_BASEMAP_STYLE || "https://tiles.openfreemap.org/styles/positron",
      center: [-73.98, 40.73],
      zoom: 10.5,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl(), "top-left");
    map.on("error", (event) => {
      if (!cancellation.signal.aborted) setError(event.error.message);
    });
    const updateBounds = () => {
      const bounds = map.getBounds();
      setMapBounds(envelope(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(), { wkid: 4326 }));
    };
    map.on("moveend", updateBounds);
    map.on("mousemove", (event) =>
      loupeRef.current({ type: "Point", coordinates: [event.lngLat.lng, event.lngLat.lat] }),
    );
    const clearProbe = () => {
      cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = 0;
      setProbe(null);
    };
    map.getCanvasContainer().addEventListener("mouseleave", clearProbe);
    map.on("click", (event) => loupeRef.current({ type: "Point", coordinates: [event.lngLat.lng, event.lngLat.lat] }));
    const ready = new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      map.once("load", () => {
        signal.removeEventListener("abort", aborted);
        resolve();
      });
    });
    void (async () => {
      try {
        const results = await Promise.all([
          connectCohort(signal).then((connected) => {
            session = connected;
            return connected;
          }),
          ready,
        ]);
        if (cancellation.signal.aborted) {
          await results[0].dispose();
          return;
        }
        const connected = results[0];
        for (const id of ["summary", "flights", "selected", "complaints", "area"])
          map.addSource(id, { type: "geojson", data: EMPTY });
        map.addLayer({
          id: "summary",
          source: "summary",
          type: "fill",
          layout: { visibility: "none" },
          paint: { "fill-color": "#64748b", "fill-opacity": 0.12, "fill-outline-color": "#64748b" },
        });
        map.addLayer({
          id: "flights",
          source: "flights",
          type: "line",
          paint: {
            "line-color": flightSpeedColor(field(connected.sources.flights, "Speed")),
            "line-width": 1.7,
            "line-opacity": 1,
          },
        });
        map.addLayer({
          id: "selected",
          source: "selected",
          type: "line",
          paint: {
            "line-color": flightSpeedColor(field(connected.sources.flights, "Speed")),
            "line-width": 4,
          },
        });
        map.addLayer({
          id: "complaints",
          source: "complaints",
          type: "circle",
          paint: {
            "circle-radius": 4,
            "circle-color": "#bd0000",
            "circle-stroke-color": "rgba(255,255,255,0.5)",
            "circle-stroke-width": 1,
          },
        });
        map.addLayer({ id: "area", source: "area", type: "line", paint: { "line-color": "#b28b00", "line-width": 3 } });
        map.on("click", "flights", (event) => {
          const id = event.features?.[0]?.id;
          if (id !== undefined) clickRef.current(String(id));
        });
        map.on("click", "complaints", (event) => {
          const properties = event.features?.[0]?.properties;
          if (properties)
            new Popup()
              .setLngLat(event.lngLat)
              .setText(
                `${label(properties, "problem_detail__formerly_descriptor_") || label(properties, "Descriptor")} · ${label(properties, "Incident_Address")}`,
              )
              .addTo(map);
        });
        const [counts, summary] = await Promise.all([
          aggregate(connected.sources.flights, {}, [field(connected.sources.flights, "DateOfFlight")], signal),
          loadFeatures(connected.sources.summary, {}, signal, 1000),
        ]);
        const available = counts
          .map((row) => {
            const dayValue = label(row, "DateOfFlight").slice(0, 10);
            nextDay(dayValue);
            return { day: dayValue, count: Number(value(row, "record_count")) };
          })
          .sort((left, right) => left.day.localeCompare(right.day));
        if (!available.length) throw new Error("The imported flight selection contains no dated flights.");
        if (cancellation.signal.aborted) return;
        (map.getSource("summary") as GeoJSONSource).setData(renderable(summary));
        updateBounds();
        setDays(available);
        setDay(available[0].day);
        setCohort(connected);
        setLoading("");
      } catch (reason) {
        if (!cancellation.signal.aborted) {
          setError(message(reason));
          setLoading("");
        }
      }
    })();
    return () => {
      cancellation.abort();
      cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = 0;
      map.getCanvasContainer().removeEventListener("mouseleave", clearProbe);
      map.remove();
      mapRef.current = null;
      if (session) void session.dispose();
    };
  }, []);

  useEffect(() => {
    if (!cohort || !day) return;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(120_000)]);
    setLoading(`Loading ${day} flights…`);
    const queryStart = performance.now();
    setError("");
    setAircraft("");
    setSelectedIds([]);
    setFlights(EMPTY);
    setDayComplaints(EMPTY);
    setAircraftRows([]);
    void (async () =>
      Promise.all([
        loadFeatures(cohort.sources.flights, dayQuery(cohort.sources.flights, "DateOfFlight", day), signal),
        loadFeatures(
          cohort.sources.complaints,
          dayQuery(cohort.sources.complaints, "Created_Date", day),
          signal,
          30_000,
        ),
        aggregate(
          cohort.sources.flights,
          dayQuery(cohort.sources.flights, "DateOfFlight", day),
          ["r", "desc_", "aircraft_type"].map((name) => field(cohort.sources.flights, name)),
          signal,
        ),
      ]))()
      .then(([features, noise, rows]) => {
        if (!cancellation.signal.aborted) {
          performance.measure("heli-flight-query", {
            start: queryStart,
            detail: { day, retry, rows: features.features.length },
          });
          if (noise.features.some((feature) => feature.geometry && feature.geometry.type !== "Point"))
            throw new Error("The complaint layer must contain point geometry.");
          setFlights(features);
          setDayComplaints(noise);
          setAircraftRows(rows);
          setLoading("");
        }
      })
      .catch((reason) => {
        if (!cancellation.signal.aborted) {
          setError(message(reason));
          setLoading("");
        }
      });
    return () => cancellation.abort();
  }, [cohort, day, retry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource("flights")) return;
    (map.getSource("flights") as GeoJSONSource).setData(renderable(flights));
  }, [flights]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource("selected")) return;
    (map.getSource("selected") as GeoJSONSource).setData(
      renderable({
        type: "FeatureCollection",
        features: selectedFlights.length ? selectedFlights : aircraftFlights,
      }),
    );
    map.setPaintProperty("flights", "line-opacity", aircraft ? 0.2 : 1);
  }, [selectedFlights, aircraftFlights, aircraft]);

  useEffect(() => {
    const map = mapRef.current;
    if (!cohort || !day || !map?.getSource("complaints")) return;
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(90_000)]);
    const queryStart = performance.now();
    setComplaintLoading(true);
    setComplaints(EMPTY);
    void (async () =>
      loadFeatures(
        cohort.sources.complaints,
        {
          ...dayQuery(cohort.sources.complaints, "Created_Date", day),
          ...(extentOnly && mapBounds ? { spatialFilter: mapBounds } : {}),
        },
        signal,
        30_000,
      ))()
      .then((features) => {
        if (!cancellation.signal.aborted) {
          performance.measure("heli-complaint-query", {
            start: queryStart,
            detail: { day, retry, rows: features.features.length, extentOnly },
          });
          setComplaints(features);
          setComplaintLoading(false);
        }
      })
      .catch((reason) => {
        if (!cancellation.signal.aborted) {
          setError(message(reason));
          setComplaintLoading(false);
        }
      });
    return () => cancellation.abort();
  }, [cohort, day, extentOnly, mapBounds, retry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource("complaints")) return;
    (map.getSource("complaints") as GeoJSONSource).setData(renderable(dayComplaints));
  }, [dayComplaints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("complaints")) return;
    map.setPaintProperty(
      "complaints",
      "circle-opacity",
      highlightedIds === null ? 1 : ["case", ["in", ["to-string", ["id"]], ["literal", highlightedIds]], 1, 0.14],
    );
    map.setPaintProperty(
      "complaints",
      "circle-stroke-opacity",
      highlightedIds === null ? 1 : ["case", ["in", ["to-string", ["id"]], ["literal", highlightedIds]], 1, 0.14],
    );
  }, [highlightedIds]);

  useEffect(() => {
    if (!cohort || !day) return;
    const geometry = loupe && probe ? probe : selectedGeometry;
    if (!geometry) {
      setHighlightedIds(null);
      setHighlightLoading(false);
      return;
    }
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]);
    setHighlightLoading(true);
    setHighlightedIds(null);
    const timer = setTimeout(
      () => {
        void (async () => {
          const query = await complaintHighlightQuery(
            cohort.sources.complaints,
            day,
            geometry,
            loupe && probe ? [] : selectedFlights,
            signal,
          );
          return matchingIds(cohort.sources.complaints, query, signal);
        })()
          .then((ids) => {
            if (!cancellation.signal.aborted) {
              setHighlightedIds(ids);
              setHighlightLoading(false);
            }
          })
          .catch((reason) => {
            if (!cancellation.signal.aborted) {
              setHighlightedIds(null);
              setHighlightLoading(false);
              setError(message(reason));
            }
          });
      },
      loupe ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      cancellation.abort();
    };
  }, [cohort, day, selectedGeometry, selectedFlights, loupe, probe]);

  useEffect(() => {
    const map = mapRef.current;
    if (!cohort || !map?.getLayer("flights")) return;
    for (const [id, visible] of [
      ["flights", showFlights],
      ["selected", showFlights],
      ["complaints", showComplaints],
      ["summary", showSummary],
    ] as const)
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }, [showFlights, showComplaints, showSummary, cohort]);

  useEffect(() => {
    const map = mapRef.current;
    if (!cohort || !day || !map?.getSource("area")) return;
    if (!loupe || !probe) {
      setStats(null);
      (map.getSource("area") as GeoJSONSource).setData(EMPTY);
      return;
    }
    const cancellation = new AbortController();
    setStats(null);
    (map.getSource("area") as GeoJSONSource).setData(renderable(halfMileAround(probe).collection));
    const timer = setTimeout(() => {
      void neighborhoodStats(cohort, day, probe, AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]))
        .then((result) => {
          if (!cancellation.signal.aborted) {
            setStats(result);
            (map.getSource("area") as GeoJSONSource).setData(renderable(result.area));
          }
        })
        .catch((reason) => {
          if (!cancellation.signal.aborted) setError(message(reason));
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      cancellation.abort();
    };
  }, [cohort, day, loupe, probe]);

  return (
    <div className="app">
      <header>
        <div>
          <p className="eyebrow">HONUA · NYC</p>
          <h1>Helicopters & neighborhood noise</h1>
        </div>
        <a href="https://esri.github.io/nyc-heli-noise-explorer/" target="_blank" rel="noreferrer">
          Original Esri sample ↗
        </a>
      </header>
      <main>
        <aside>
          <section>
            <h2>Explore a day</h2>
            <p className="muted">Available imported flight dates · UTC</p>
            <div className="calendar" aria-label="Flight calendar">
              {days.map((entry) => (
                <button
                  type="button"
                  key={entry.day}
                  aria-pressed={day === entry.day}
                  onClick={() => setDay(entry.day)}
                  title={`${entry.day}: ${entry.count} flight records`}
                >
                  <span>{entry.day.slice(5)}</span>
                  <strong>{number(entry.count)}</strong>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2>Map layers</h2>
            {(
              [
                ["Flight tracks", showFlights, setShowFlights],
                ["Noise complaints", showComplaints, setShowComplaints],
                ["Census tract boundaries", showSummary, setShowSummary],
              ] as const
            ).map(([name, checked, change]) => (
              <label className="toggle" key={name}>
                <input type="checkbox" checked={checked} onChange={(event) => change(event.target.checked)} />
                {name}
              </label>
            ))}
            <div className="legend">
              <span>
                <i className="complaint" />
                Complaints
              </span>
              <span>Selected flight tracks are thicker.</span>
            </div>
            <div className="speed-legend" aria-label="Flight speed color scale">
              <strong>Flight speed</strong>
              <div className="speed-stops">
                {FLIGHT_SPEED_STOPS.map(([stop, [r, g, b]]) => (
                  <span key={stop}>
                    <i style={{ background: `rgba(${r},${g},${b},${79 / 255})` }} />
                    {stop}
                  </span>
                ))}
              </div>
            </div>
          </section>
          <section>
            <h2>Filter by aircraft</h2>
            {aircraft && (
              <button
                type="button"
                onClick={() => {
                  setAircraft("");
                  setSelectedIds([]);
                }}
              >
                ← All aircraft
              </button>
            )}
            <div className="aircraft-list">
              {aircraftRows
                .filter((row) => label(row, "r"))
                .sort((left, right) => Number(value(right, "record_count")) - Number(value(left, "record_count")))
                .map((row) => (
                  <button
                    type="button"
                    key={`${label(row, "r")}-${label(row, "desc_")}-${label(row, "aircraft_type")}`}
                    aria-pressed={aircraft === label(row, "r")}
                    onClick={() => {
                      setAircraft(label(row, "r"));
                      setSelectedIds([]);
                    }}
                  >
                    <strong>{label(row, "r")}</strong>
                    <span>{label(row, "desc_") || label(row, "aircraft_type")}</span>
                    <small>{number(value(row, "record_count"))} tracks</small>
                  </button>
                ))}
            </div>
          </section>
          <section>
            <h2>Neighborhood lens</h2>
            <label className="toggle">
              <input type="checkbox" checked={loupe} onChange={(event) => setLoupe(event.target.checked)} />
              Inspect a half-mile area
            </label>
            {loupe && (
              <>
                <p className="muted">
                  Move across the map and pause for statistics. Click also works on touch screens.
                </p>
                <dl>
                  <dt>Population</dt>
                  <dd>{number(stats?.population)}</dd>
                  <dt>Average household income</dt>
                  <dd>{stats?.income == null ? "—" : `$${number(stats.income)}`}</dd>
                  <dt>Complaints on this day</dt>
                  <dd>{number(stats?.complaints)}</dd>
                </dl>
                <small>
                  Population sums and income averages use intersecting whole tracts, as in the source sample.
                </small>
              </>
            )}
          </section>
        </aside>
        <div className="workspace">
          <div className="map" ref={container} aria-label="Map of NYC helicopter tracks and noise complaints" />
          <output className="status">
            {loading || `${day || "Loading dates"} · ${number(flights.features.length)} flight records`}
            {complaintLoading ? " · Loading complaints…" : ""}
            {highlightLoading ? " · Finding nearby complaints…" : ""}
          </output>
          {error && (
            <div role="alert" className="error">
              {error}
              <button type="button" onClick={() => (cohort ? setRetry((revision) => revision + 1) : location.reload())}>
                Retry queries
              </button>
            </div>
          )}
          {aircraft && (
            <section className="timeline">
              <h2>
                {aircraft} flight timeline <small>UTC</small>
              </h2>
              <p className="muted">
                Select tracks to highlight complaints within half a mile and the selected start-time range. The table
                keeps its day and viewport filters.
              </p>
              <FlightChart features={aircraftFlights} selected={selectedIds} onSelect={setSelectedIds} />
              <FlightRecords
                key={aircraft}
                features={aircraftFlights}
                selected={selectedIds}
                onSelect={setSelectedIds}
              />
            </section>
          )}
          <section className="complaints">
            <div className="section-heading">
              <h2>
                Noise complaints <small>{complaintLoading ? "Loading" : number(complaints.features.length)}</small>
              </h2>
              <label className="toggle">
                <input type="checkbox" checked={extentOnly} onChange={(event) => setExtentOnly(event.target.checked)} />
                Current map extent
              </label>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time (UTC)</th>
                    <th>Description</th>
                    <th>Location</th>
                    <th>Borough</th>
                  </tr>
                </thead>
                <tbody>
                  {complaints.features.map((feature) => (
                    <tr key={feature.id}>
                      <td>{time(value(feature.properties, "Created_Date"))}</td>
                      <td>
                        {label(feature.properties, "problem_detail__formerly_descriptor_") ||
                          label(feature.properties, "Descriptor")}
                      </td>
                      <td>{label(feature.properties, "Incident_Address")}</td>
                      <td>{label(feature.properties, "Borough")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!complaintLoading && !complaints.features.length && (
                <p>No complaints match the current day and spatial filters.</p>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
