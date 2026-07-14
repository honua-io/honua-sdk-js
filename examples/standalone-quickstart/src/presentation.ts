import type { StandaloneDataset } from "./data.js";

function featureTitle(properties: Record<string, unknown>, id: string | number | undefined): string {
  return (
    (typeof properties.NAME === "string" && properties.NAME) ||
    (typeof properties.name === "string" && properties.name) ||
    `Feature ${id ?? ""}`
  );
}

/** Render untrusted remote feature attributes without interpreting them as markup. */
export function renderStandaloneFeatureList(container: HTMLElement, dataset: StandaloneDataset): void {
  container.replaceChildren();
  for (const feature of dataset.geojson.features.slice(0, 12)) {
    const properties = feature.properties ?? {};
    const detailKey = Object.keys(properties).find((key) => key !== "NAME" && key !== "name");
    const row = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = featureTitle(properties, feature.id);
    const detail = document.createElement("span");
    detail.textContent = detailKey ? `${detailKey}: ${String(properties[detailKey])}` : "";
    row.append(title, detail);
    container.append(row);
  }
  if (container.childElementCount === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-copy";
    empty.textContent = "No features returned.";
    container.append(empty);
  }
}
