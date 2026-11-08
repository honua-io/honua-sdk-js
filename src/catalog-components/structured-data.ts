import type { CatalogStructuredData } from "./presentation.js";

interface DocumentContributions {
  readonly owners: Map<object, CatalogStructuredData>;
  readonly block: HTMLScriptElement;
}

const contributions = new WeakMap<Document, DocumentContributions>();

export function contributeCatalogStructuredData(
  document: Document,
  owner: object,
  projection: CatalogStructuredData,
): () => void {
  let current = contributions.get(document);
  if (!current) {
    const block = document.createElement("script");
    block.type = "application/ld+json";
    block.dataset.honuaCatalogStructuredData = "";
    current = { owners: new Map(), block };
    contributions.set(document, current);
  }
  current.owners.set(owner, projection);
  renderContributions(document, current);
  const captured = current;
  return () => {
    if (captured.owners.get(owner) !== projection) return;
    captured.owners.delete(owner);
    renderContributions(document, captured);
  };
}

function renderContributions(document: Document, current: DocumentContributions): void {
  if (current.owners.size === 0) {
    current.block.remove();
    contributions.delete(document);
    return;
  }
  const contexts = new Map<string, string>();
  const subjects = new Map<string, Record<string, unknown>>();
  for (const projection of current.owners.values()) {
    for (const [prefix, uri] of Object.entries(projection["@context"])) contexts.set(prefix, uri);
    for (const subject of projection["@graph"]) {
      const id = subject["@id"];
      if (typeof id !== "string" || !URL.canParse(id)) continue;
      const merged = subjects.get(id) ?? Object.create(null);
      for (const [key, value] of Object.entries(subject)) {
        const previous = merged[key];
        if (previous === undefined || JSON.stringify(previous) === JSON.stringify(value)) merged[key] = value;
        else
          merged[key] = [...new Map([previous, value].flat().map((entry) => [JSON.stringify(entry), entry])).values()];
      }
      subjects.set(id, merged);
    }
  }
  current.block.textContent = JSON.stringify({
    "@context": Object.fromEntries(contexts),
    "@graph": [...subjects.values()],
  }).replaceAll("<", "\\u003c");
  if (!current.block.isConnected) document.head.append(current.block);
}
