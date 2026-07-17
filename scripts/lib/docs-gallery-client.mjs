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
    renderer: String(filters.renderer ?? ""),
    dataMode: String(filters.dataMode ?? ""),
    authMode: String(filters.authMode ?? ""),
    supportTier: String(filters.supportTier ?? ""),
    lifecycleState: String(filters.lifecycleState ?? ""),
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
    (!normalized.protocol || card.protocols.includes(normalized.protocol)) &&
    (!normalized.renderer || card.renderers.includes(normalized.renderer)) &&
    (!normalized.dataMode || card.dataMode === normalized.dataMode) &&
    (!normalized.authMode || card.authMode === normalized.authMode) &&
    (!normalized.supportTier || card.supportTier === normalized.supportTier) &&
    (!normalized.lifecycleState || card.lifecycleState === normalized.lifecycleState)
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

export function initializeGallery(root = document) {
  const controls = root.querySelector("[data-gallery-controls]");
  if (!controls) return;

  const search = controls.querySelector("[data-gallery-search]");
  const capability = controls.querySelector("[data-gallery-capability]");
  const protocol = controls.querySelector("[data-gallery-protocol]");
  const renderer = controls.querySelector("[data-gallery-renderer]");
  const dataMode = controls.querySelector("[data-gallery-data-mode]");
  const authMode = controls.querySelector("[data-gallery-auth-mode]");
  const supportTier = controls.querySelector("[data-gallery-support-tier]");
  const lifecycleState = controls.querySelector("[data-gallery-lifecycle-state]");
  const clear = controls.querySelector("[data-gallery-clear]");
  const count = root.querySelector("[data-gallery-result-count]");
  const empty = root.querySelector("[data-gallery-empty]");
  const groups = [...root.querySelectorAll("[data-gallery-group]")];
  const records = [...root.querySelectorAll("[data-gallery-card]")].map((element) => ({
    id: element.dataset.sampleId ?? "",
    searchText: element.dataset.gallerySearchText ?? "",
    capabilities: parseFacetValues(element.dataset.galleryCapabilities),
    protocols: parseFacetValues(element.dataset.galleryProtocols),
    renderers: parseFacetValues(element.dataset.galleryRenderers),
    dataMode: element.dataset.galleryDataMode ?? "",
    authMode: element.dataset.galleryAuthMode ?? "",
    supportTier: element.dataset.gallerySupportTier ?? "",
    lifecycleState: element.dataset.galleryLifecycleState ?? "",
    element,
  }));

  if (
    !search ||
    !capability ||
    !protocol ||
    !renderer ||
    !dataMode ||
    !authMode ||
    !supportTier ||
    !lifecycleState ||
    !clear ||
    !count ||
    !empty
  ) return;

  const apply = () => {
    const filters = normalizeGalleryFilters({
      text: search.value,
      capability: capability.value,
      protocol: protocol.value,
      renderer: renderer.value,
      dataMode: dataMode.value,
      authMode: authMode.value,
      supportTier: supportTier.value,
      lifecycleState: lifecycleState.value,
    });
    const visibleIds = new Set(filterGalleryCards(records, filters).map((record) => record.id));

    for (const record of records) record.element.hidden = !visibleIds.has(record.id);
    for (const group of groups) {
      group.hidden = !group.querySelector("[data-gallery-card]:not([hidden])");
    }

    count.textContent = String(visibleIds.size);
    empty.hidden = visibleIds.size !== 0;
    clear.disabled = !Object.values(filters).some(Boolean);
  };

  search.addEventListener("input", apply);
  capability.addEventListener("change", apply);
  protocol.addEventListener("change", apply);
  renderer.addEventListener("change", apply);
  dataMode.addEventListener("change", apply);
  authMode.addEventListener("change", apply);
  supportTier.addEventListener("change", apply);
  lifecycleState.addEventListener("change", apply);
  controls.addEventListener("submit", (event) => {
    event.preventDefault();
    apply();
  });
  clear.addEventListener("click", () => {
    search.value = "";
    capability.value = "";
    protocol.value = "";
    renderer.value = "";
    dataMode.value = "";
    authMode.value = "";
    supportTier.value = "";
    lifecycleState.value = "";
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
