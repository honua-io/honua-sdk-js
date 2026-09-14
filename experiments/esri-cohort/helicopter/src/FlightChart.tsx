import { useMemo } from "react";
import { FLIGHT_CHART, flightChart } from "./chart-model.mjs";
import type { MapFeature } from "./data.js";
import { value } from "./data.js";

const clock = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });

export function FlightChart({
  features,
  selected,
  onSelect,
}: {
  features: MapFeature[];
  selected: string[];
  onSelect(ids: string[]): void;
}) {
  const result = useMemo(() => {
    try {
      return {
        chart: flightChart(
          features.map((feature) => {
            const raw = value(feature.properties, FLIGHT_CHART.field);
            return { id: String(feature.id), timestamp: typeof raw === "number" ? raw : Date.parse(String(raw)) };
          }),
        ),
        error: null,
      };
    } catch (error) {
      return { chart: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [features]);
  if (!result.chart) return <p role="alert">{result.error}</p>;
  const { bins, start, end, trimmed } = result.chart;
  if (!bins.length || start === null || end === null)
    return <p className="muted">No complete six-minute intervals. Individual flight records remain available below.</p>;
  const maximum = Math.max(1, ...bins.map((bin) => bin.count ?? 0));
  const x = (index: number) => ((index + 0.5) / bins.length) * 100;
  const y = (count: number) => 90 - (count / maximum) * 80;
  const segments: { key: number; points: string }[] = [];
  for (const [index, bin] of bins.entries()) {
    if (bin.count === null) continue;
    const point = `${x(index)},${y(bin.count)}`;
    if (index === 0 || bins[index - 1].count === null) segments.push({ key: index, points: point });
    else segments[segments.length - 1].points += ` ${point}`;
  }
  return (
    <div className="flight-chart">
      <div className="chart-axis">
        <span>{maximum} records</span>
        <span>0</span>
      </div>
      <fieldset className="chart-plot" aria-label="Flight record counts in six-minute intervals">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 90H100" stroke="#ccd8d4" fill="none" vectorEffect="non-scaling-stroke" />
          {segments.map((segment) => (
            <polyline
              key={segment.key}
              points={segment.points}
              fill="none"
              stroke="#1ea87c"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {bins.map(
          (bin, index) =>
            bin.count !== null && (
              <button
                type="button"
                disabled={bin.ids.length === 0}
                key={bin.start}
                className="chart-point"
                style={{ left: `${x(index)}%`, top: `${y(bin.count)}%` }}
                aria-pressed={bin.ids.some((id) => selected.includes(id))}
                aria-label={`${clock(bin.start)} to ${clock(bin.end)} UTC: ${bin.count} flight records`}
                title={`${clock(bin.start)}–${clock(bin.end)} · ${bin.count} flight records`}
                onClick={() =>
                  onSelect(
                    bin.ids.every((id) => selected.includes(id))
                      ? selected.filter((id) => !bin.ids.includes(id))
                      : [...new Set([...selected, ...bin.ids])],
                  )
                }
              />
            ),
        )}
      </fieldset>
      <div className="chart-time-axis">
        <span>{clock(start)} UTC</span>
        <span>{clock(end)} UTC</span>
      </div>
      <p className="muted">
        Six-minute intervals. {trimmed} records fall in the incomplete trailing interval and remain in the map and
        record list.
      </p>
    </div>
  );
}
