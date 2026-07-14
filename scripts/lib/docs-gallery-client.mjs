/**
 * Normalize user-entered gallery text without locale-dependent ordering or
 * case rules. The same function is used when the static search index is built
 * and when a visitor enters a query.
 */
export function normalizeGalleryText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeGalleryFilters(filters = {}) {
  return {
    text: normalizeGalleryText(filters.text),
    capability: String(filters.capability ?? ""),
    protocol: String(filters.protocol ?? ""),
  };
}

/**
 * Match a presentation-safe gallery record. Text terms use AND semantics so
 * "realtime map" remains useful as the gallery grows; facet values are exact.
 */
export function matchesGalleryCard(card, filters = {}) {
  const normalized = normalizeGalleryFilters(filters);
  const terms = normalized.text.split(" ").filter(Boolean);
  return (
    terms.every((term) => card.searchText.includes(term)) &&
    (!normalized.capability || card.capabilities.includes(normalized.capability)) &&
    (!normalized.protocol || card.protocols.includes(normalized.protocol))
  );
}

export function filterGalleryCards(cards, filters = {}) {
  return cards.filter((card) => matchesGalleryCard(card, filters));
}

function parseFacetValues(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function initializeGallery(root = document) {
  const controls = root.querySelector("[data-gallery-controls]");
  if (!controls) return;

  const search = controls.querySelector("[data-gallery-search]");
  const capability = controls.querySelector("[data-gallery-capability]");
  const protocol = controls.querySelector("[data-gallery-protocol]");
  const clear = controls.querySelector("[data-gallery-clear]");
  const count = root.querySelector("[data-gallery-result-count]");
  const empty = root.querySelector("[data-gallery-empty]");
  const groups = [...root.querySelectorAll("[data-gallery-group]")];
  const records = [...root.querySelectorAll("[data-gallery-card]")].map((element) => ({
    id: element.dataset.sampleId ?? "",
    searchText: element.dataset.gallerySearchText ?? "",
    capabilities: parseFacetValues(element.dataset.galleryCapabilities),
    protocols: parseFacetValues(element.dataset.galleryProtocols),
    element,
  }));

  if (!search || !capability || !protocol || !clear || !count || !empty) return;

  const apply = () => {
    const filters = normalizeGalleryFilters({
      text: search.value,
      capability: capability.value,
      protocol: protocol.value,
    });
    const visibleIds = new Set(filterGalleryCards(records, filters).map((record) => record.id));

    for (const record of records) record.element.hidden = !visibleIds.has(record.id);
    for (const group of groups) {
      group.hidden = !group.querySelector("[data-gallery-card]:not([hidden])");
    }

    count.textContent = String(visibleIds.size);
    empty.hidden = visibleIds.size !== 0;
    clear.disabled = !filters.text && !filters.capability && !filters.protocol;
  };

  search.addEventListener("input", apply);
  capability.addEventListener("change", apply);
  protocol.addEventListener("change", apply);
  controls.addEventListener("submit", (event) => {
    event.preventDefault();
    apply();
  });
  clear.addEventListener("click", () => {
    search.value = "";
    capability.value = "";
    protocol.value = "";
    apply();
    search.focus();
  });
  apply();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initializeGallery(document), { once: true });
  } else {
    initializeGallery(document);
  }
}
