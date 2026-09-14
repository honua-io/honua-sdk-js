import { useEffect, useRef, useState } from "react";
import embed from "vega-embed";
import type { VisualizationSpec } from "vega-embed";
import { COLORS, FUELS } from "./data.js";
import type { PlantData } from "./data.js";

export function Chart({ data, kind, dark }: { data: PlantData; kind: "pie" | "box"; dark: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!container.current) return;
    // Each effect owns its host so a late StrictMode embed cannot append controls
    // into the current chart after its cleanup has already run.
    const host = document.createElement("div");
    container.current.replaceChildren(host);
    let disposed = false;
    let finalize: (() => void) | undefined;
    const common = {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      width: 460,
      height: 220,
      background: dark ? "#282b2e" : "#fffaf0",
      config: {
        axis: { labelColor: dark ? "#eee" : "#333", titleColor: dark ? "#eee" : "#333" },
        legend: { labelColor: dark ? "#eee" : "#333", titleColor: dark ? "#eee" : "#333" },
      },
    };
    const total = data.counts.reduce((sum, row) => sum + row.count, 0);
    const groups = new Map<string, number>();
    for (const row of data.counts) {
      const key = row.count / total < 0.04 ? "grouped other" : row.fuel;
      groups.set(key, (groups.get(key) ?? 0) + row.count);
    }
    const colors = { domain: [...FUELS, "grouped other"], range: [...COLORS, "#b8b8b8"] };
    const spec: VisualizationSpec =
      kind === "pie"
        ? {
            ...common,
            data: { values: [...groups].map(([fuel, count]) => ({ fuel, count, share: count / total })) },
            mark: { type: "arc", innerRadius: 48, tooltip: true },
            encoding: {
              theta: { field: "count", type: "quantitative" },
              order: { field: "count", sort: "descending" },
              color: { field: "fuel", type: "nominal", scale: colors, legend: null },
              tooltip: [
                { field: "fuel", title: "Fuel" },
                { field: "count", title: "Plants", format: ",d" },
                { field: "share", title: "Share", format: ".1%" },
              ],
            },
          }
        : {
            ...common,
            data: { values: data.geojson.features.map((feature) => feature.properties) },
            mark: { type: "boxplot", extent: 1.5, outliers: true },
            encoding: {
              x: { field: "fuel", type: "nominal", title: "Fuel type", sort: "ascending" },
              y: { field: "capacity", type: "quantitative", title: "Capacity (MW)", scale: { zero: true } },
              color: { field: "fuel", type: "nominal", scale: colors, legend: null },
            },
          };
    void embed(host, spec, {
      actions: { export: true, source: false, compiled: false, editor: false },
      renderer: "svg",
    })
      .then((result) => {
        if (disposed) result.finalize();
        else finalize = () => result.finalize();
      })
      .catch((failure) => {
        if (!disposed) setError(String(failure));
      });
    return () => {
      disposed = true;
      finalize?.();
      host.remove();
    };
  }, [data, kind, dark]);
  return (
    <section className="chart">
      <h2>
        {kind === "pie"
          ? "Distribution of power plants by fuel type (%)"
          : "Distribution of power plant capacity (MW) by fuel type"}
      </h2>
      {error && <p role="alert">{error}</p>}
      <div ref={container} aria-label={kind === "pie" ? "Fuel distribution chart" : "Capacity box plot"} />
      {kind === "pie" && (
        <div className="fuel-counts">
          {data.counts
            .slice()
            .sort((a, b) => b.count - a.count)
            .map((row) => (
              <span key={row.fuel}>
                {row.fuel}: {row.count.toLocaleString()} ({((100 * row.count) / totalCount(data)).toFixed(1)}%)
              </span>
            ))}
        </div>
      )}
    </section>
  );
}

function totalCount(data: PlantData) {
  return data.counts.reduce((sum, row) => sum + row.count, 0);
}
