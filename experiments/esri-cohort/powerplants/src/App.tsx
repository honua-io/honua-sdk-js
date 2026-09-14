import * as maplibre from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { Chart } from "./Charts.js";
import { COLORS, FUELS, RENEWABLE, loadPlants } from "./data.js";
import type { PlantData } from "./data.js";

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<PlantData | null>(null);
  const [progress, setProgress] = useState("Connecting…");
  const [error, setError] = useState("");
  const [dark, setDark] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [about, setAbout] = useState(false);
  const [filter, setFilter] = useState("all");
  const [pie, setPie] = useState(true);
  const [box, setBox] = useState(false);
  useEffect(() => {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(180_000)]);
    void loadPlants(signal, setProgress)
      .then((loaded) => {
        if (!signal.aborted) setData(loaded);
      })
      .catch((failure) => {
        if (!cancellation.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => cancellation.abort();
  }, []);
  useEffect(() => {
    if (!container.current || !data) return;
    const style = dark
      ? import.meta.env.VITE_DARK_BASEMAP_STYLE || "https://tiles.openfreemap.org/styles/dark"
      : import.meta.env.VITE_LIGHT_BASEMAP_STYLE || "https://tiles.openfreemap.org/styles/positron";
    const map = new maplibre.Map({
      container: container.current,
      style,
      center: [12, 20],
      zoom: 1.5,
    });
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    map.addControl(new maplibre.NavigationControl());
    map.on("error", (event) => setError(event.error.message));
    map.on("load", () => {
      map.addSource("plants", { type: "geojson", data: data.geojson, promoteId: "id" });
      map.addLayer({
        id: "plants",
        type: "circle",
        source: "plants",
        paint: {
          "circle-radius": 3,
          "circle-opacity": 0.8,
          "circle-color": [
            "coalesce",
            [
              "get",
              ["get", "fuel"],
              ["literal", Object.fromEntries(FUELS.map((fuel, index) => [fuel, COLORS[index]]))],
            ],
            "#888888",
          ],
        },
      });
      map.on("click", "plants", (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;
        const properties = feature.properties;
        new maplibre.Popup()
          .setLngLat(feature.geometry.coordinates as [number, number])
          .setText(
            `${properties.name} · ${properties.country} · ${properties.fuel} · ${properties.capacity ?? "Unknown"} MW`,
          )
          .addTo(map);
      });
    });
    return () => {
      resize.disconnect();
      map.remove();
    };
  }, [data, dark]);
  const plants =
    data?.geojson.features.filter((feature) => filter === "all" || feature.properties.fuel === filter) ?? [];
  const renewable = plants.filter((feature) => RENEWABLE.has(feature.properties.fuel)).length;
  const percent = (count: number) => (plants.length ? Math.round((100 * count) / plants.length) : 0);
  return (
    <main className={dark ? "dark" : "light"}>
      <header>
        <button type="button" aria-label="Toggle sidebar" onClick={() => setSidebar((value) => !value)}>
          ☰
        </button>
        <h1>Global Power Plants</h1>
        <button type="button" onClick={() => setDark((value) => !value)}>
          {dark ? "Light mode" : "Dark mode"}
        </button>
        <button type="button" onClick={() => setAbout((value) => !value)}>
          About
        </button>
      </header>
      {about && (
        <section className="about">
          <h2>About this dashboard</h2>
          <p>
            Explore global power plants, energy sources and generating capacity. Metrics use the selected fuel; the map
            and charts show all plants.
          </p>
          <button type="button" onClick={() => setAbout(false)}>
            Close about
          </button>
        </section>
      )}
      <div className="workspace">
        {sidebar && (
          <aside>
            <h2>Dashboard options</h2>
            <fieldset>
              <legend>Filter metrics</legend>
              {["all", "solar", "oil"].map((fuel) => (
                <label key={fuel}>
                  <input
                    type="radio"
                    name="fuel"
                    value={fuel}
                    checked={filter === fuel}
                    onChange={() => setFilter(fuel)}
                  />
                  {fuel === "all" ? "All" : fuel === "solar" ? "Solar" : "Oil"}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Chart projections</legend>
              <label>
                <input type="checkbox" checked={pie} onChange={(event) => setPie(event.target.checked)} />
                Show pie chart
              </label>
              <label>
                <input type="checkbox" checked={box} onChange={(event) => setBox(event.target.checked)} />
                Show box plot
              </label>
            </fieldset>
            <details>
              <summary>Map legend</summary>
              {FUELS.map((fuel, index) => (
                <p key={fuel}>
                  <i style={{ background: COLORS[index] }} />
                  {fuel}
                </p>
              ))}
            </details>
          </aside>
        )}
        <div className="content">
          {error ? <p role="alert">{error}</p> : !data ? <output>{progress}</output> : null}
          <section className="metrics" aria-label="Power plant metrics">
            <article>
              <h2>Total number of plants</h2>
              <strong>{data ? plants.length.toLocaleString() : "—"}</strong>
            </article>
            <article>
              <h2>Renewable plants</h2>
              <strong>{data ? `${percent(renewable)}%` : "—"}</strong>
            </article>
            <article>
              <h2>Non-renewable plants</h2>
              <strong>{data ? `${percent(plants.length - renewable)}%` : "—"}</strong>
            </article>
          </section>
          <div className="map" ref={container} role="application" aria-label="Global power plant map" />
          <div className="charts">
            {data && pie && <Chart data={data} kind="pie" dark={dark} />}
            {data && box && <Chart data={data} kind="box" dark={dark} />}
          </div>
        </div>
      </div>
      <footer>
        World Resources Institute · Global Power Plant Database{" "}
        <span>
          {data ? `${data.geojson.features.length.toLocaleString()} plants reconciled to server fuel counts` : progress}
        </span>
      </footer>
    </main>
  );
}
