import { useMemo, useState } from "react";
import type { MapFeature } from "./data.js";
import { value } from "./data.js";

const PAGE_SIZE = 200;
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
const time = (input: unknown) => {
  const date = new Date(typeof input === "number" ? input : String(input));
  return Number.isFinite(date.getTime()) ? clock.format(date) : "Unknown time";
};

export function FlightRecords({
  features,
  selected,
  onSelect,
}: {
  features: MapFeature[];
  selected: string[];
  onSelect(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const sorted = useMemo(
    () =>
      features
        .slice()
        .sort((left, right) => Number(value(left.properties, "start_t")) - Number(value(right.properties, "start_t"))),
    [features],
  );
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(pageIndex, pages - 1);
  const start = page * PAGE_SIZE;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Individual flight records ({features.length})</summary>
      {open && (
        <>
          <nav aria-label="Individual flight record pages">
            <button type="button" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>
              Previous records
            </button>
            <output aria-live="polite">
              Records {sorted.length ? start + 1 : 0}–{Math.min(start + PAGE_SIZE, sorted.length)} of {sorted.length}
            </output>
            <button type="button" disabled={page + 1 === pages} onClick={() => setPageIndex(page + 1)}>
              Next records
            </button>
          </nav>
          <div className="timeline-tracks">
            {sorted.slice(start, start + PAGE_SIZE).map((feature) => {
              const id = String(feature.id);
              return (
                <button
                  type="button"
                  key={id}
                  aria-pressed={selectedIds.has(id)}
                  onClick={() =>
                    onSelect(selectedIds.has(id) ? selected.filter((item) => item !== id) : [...selected, id])
                  }
                >
                  {time(value(feature.properties, "start_t"))}–{time(value(feature.properties, "end_t"))}
                </button>
              );
            })}
          </div>
        </>
      )}
    </details>
  );
}
