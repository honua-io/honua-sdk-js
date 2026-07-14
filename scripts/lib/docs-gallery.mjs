import { normalizeGalleryText } from "./docs-gallery-client.mjs";

const PUBLIC_GALLERY_TRACKS = Object.freeze([
  { track: "golden", title: "Golden journeys" },
  { track: "recipe", title: "Recipes" },
  { track: "lab", title: "Labs" },
]);

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function resolvedReplacement(replacement, indexes, publicSampleIds) {
  if (!replacement) return null;
  if (replacement.kind === "sample") {
    const sample = indexes.samples.get(replacement.id);
    return {
      ...replacement,
      title: sample?.title ?? replacement.id,
      publicSampleId: publicSampleIds.has(replacement.id) ? replacement.id : null,
    };
  }
  if (replacement.kind === "journey") {
    const journey = indexes.journeys.get(replacement.id);
    const candidateSampleId = journey?.candidateSampleId ?? null;
    return {
      ...replacement,
      title: journey?.title ?? replacement.id,
      status: journey?.status ?? "unknown",
      candidateSampleId,
      publicSampleId: publicSampleIds.has(candidateSampleId) ? candidateSampleId : null,
    };
  }
  const external = indexes.externalReplacements.get(replacement.id);
  return {
    ...replacement,
    title: external?.title ?? replacement.id,
    url: external?.url ?? null,
  };
}

function gallerySearchText(card) {
  const { sample, journey, replacement } = card;
  return normalizeGalleryText(
    [
      sample.id,
      sample.title,
      sample.summary,
      sample.track,
      sample.supportTier,
      sample.validationProfile,
      sample.sdk.package,
      sample.sdk.version,
      ...sample.capabilities,
      ...sample.protocols,
      ...sample.renderers,
      sample.data.mode,
      sample.data.authMode,
      sample.data.configurationStatus,
      sample.evidence.fixture.mode,
      sample.evidence.fixture.status,
      sample.evidence.live.mode,
      sample.evidence.live.targetMode,
      sample.evidence.live.status,
      sample.lifecycle.state,
      journey?.id,
      journey?.title,
      journey?.status,
      replacement?.kind,
      replacement?.id,
      replacement?.title,
    ]
      .filter((value) => value !== undefined && value !== null)
      .join(" "),
  );
}

/**
 * Build the deterministic public-gallery model from the presentation-safe
 * catalog-v2 site projection. Internal fixture entries remain available to
 * validation but are intentionally not promoted as public applications.
 */
export function createGalleryModel(siteProjection) {
  if (!siteProjection || !Array.isArray(siteProjection.samples)) {
    throw new TypeError("Gallery projection must contain a samples array.");
  }

  const journeys = Array.isArray(siteProjection.goldenJourneys) ? siteProjection.goldenJourneys : [];
  const externalReplacements = Array.isArray(siteProjection.externalReplacements)
    ? siteProjection.externalReplacements
    : [];
  const indexes = {
    samples: new Map(siteProjection.samples.map((sample) => [sample.id, sample])),
    journeys: new Map(journeys.map((journey) => [journey.id, journey])),
    externalReplacements: new Map(externalReplacements.map((replacement) => [replacement.id, replacement])),
  };
  const publicTracks = new Set(PUBLIC_GALLERY_TRACKS.map(({ track }) => track));
  const publicSamples = siteProjection.samples.filter((sample) => publicTracks.has(sample.track));
  const publicSampleIds = new Set(publicSamples.map((sample) => sample.id));
  const provenance = {
    projection: {
      format: siteProjection.format,
      schemaVersion: siteProjection.schemaVersion,
    },
    catalog: structuredClone(siteProjection.catalog ?? {}),
    contract: structuredClone(siteProjection.contract ?? {}),
  };
  const cards = publicSamples.map((sample) => {
    const card = {
      sample: structuredClone(sample),
      journey: sample.journeyId
        ? structuredClone(indexes.journeys.get(sample.journeyId) ?? {
            id: sample.journeyId,
            title: sample.journeyId,
            status: "unknown",
            candidateSampleId: sample.id,
          })
        : null,
      replacement: resolvedReplacement(sample.lifecycle.replacement, indexes, publicSampleIds),
    };
    return { ...card, searchText: gallerySearchText(card) };
  });
  const groups = PUBLIC_GALLERY_TRACKS.map(({ track, title }) => ({
    track,
    title,
    cards: cards.filter((card) => card.sample.track === track),
  })).filter((group) => group.cards.length > 0);

  if (cards.length === 0) {
    throw new Error("Gallery projection produced zero public cards; refusing to publish an empty gallery.");
  }

  return {
    cardCount: cards.length,
    provenance,
    filters: {
      capabilities: sortedUnique(cards.flatMap((card) => card.sample.capabilities)),
      protocols: sortedUnique(cards.flatMap((card) => card.sample.protocols)),
    },
    groups,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function renderTags(values, label) {
  if (values.length === 0) return '<span class="demo-none">None declared</span>';
  return `<ul class="demo-tags" aria-label="${escapeHtml(label)}">${values
    .map((value) => `<li><code>${escapeHtml(value)}</code></li>`)
    .join("")}</ul>`;
}

function renderEvidenceSummary(sample) {
  const fixture = sample.evidence.fixture;
  const live = sample.evidence.live;
  const liveParts = [
    `<code>${escapeHtml(live.mode)}</code>`,
    `<strong>${escapeHtml(live.status)}</strong>`,
  ];
  if (live.expiresAt) {
    liveParts.push(
      `<span class="demo-evidence-expiry">evidence expires <time datetime="${escapeHtml(
        live.expiresAt,
      )}">${escapeHtml(live.expiresAt)}</time></span>`,
    );
  }
  return `<span class="demo-evidence-line">Fixture: <strong>${escapeHtml(fixture.status)}</strong></span>
<span class="demo-evidence-line">Live: ${liveParts.join(" · ")}</span>`;
}

function renderEvidenceDetails(sample) {
  const fixture = sample.evidence.fixture;
  const live = sample.evidence.live;
  const parts = [
    `<span class="demo-evidence-line">Fixture mode <code>${escapeHtml(
      fixture.mode,
    )}</code> · status <strong>${escapeHtml(fixture.status)}</strong></span>`,
    `<span class="demo-evidence-line">Live mode <code>${escapeHtml(
      live.mode,
    )}</code> · status <strong>${escapeHtml(live.status)}</strong></span>`,
  ];
  if (live.targetMode) {
    parts.push(
      `<span class="demo-evidence-line">Target mode <code>${escapeHtml(live.targetMode)}</code></span>`,
    );
  }
  if (live.evidencePath) {
    parts.push(
      `<span class="demo-evidence-line">Evidence reference <code>${escapeHtml(
        live.evidencePath,
      )}</code></span>`,
    );
  }
  return parts.join("\n");
}

function renderLifecycle(sample) {
  const lifecycle = sample.lifecycle;
  const parts = [`<strong>${escapeHtml(lifecycle.state)}</strong> — ${escapeHtml(lifecycle.reason)}`];
  if (lifecycle.targetRelease) {
    parts.push(`target release <code>${escapeHtml(lifecycle.targetRelease)}</code>`);
  }
  return parts.join(" · ");
}

function renderReplacement(replacement) {
  if (!replacement) return '<span class="demo-none">None</span>';
  const label = `${replacement.kind}: ${replacement.title} (${replacement.id})`;
  if (replacement.kind === "external") {
    const href = safeHttpUrl(replacement.url);
    return href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      : escapeHtml(label);
  }
  if (replacement.publicSampleId) {
    return `<a href="#sample-${escapeHtml(encodeURIComponent(replacement.publicSampleId))}">${escapeHtml(label)}</a>`;
  }
  return escapeHtml(label);
}

function renderJourney(journey) {
  if (!journey) return '<span class="demo-none">None</span>';
  return `${escapeHtml(journey.title)} (<code>${escapeHtml(journey.id)}</code>) · <strong>${escapeHtml(
    journey.status,
  )}</strong>`;
}

function renderOption(value) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
}

function renderGalleryProvenance(gallery) {
  const catalog = gallery.provenance.catalog;
  const projection = gallery.provenance.projection;
  const contract = gallery.provenance.contract;
  return `<aside class="gallery-provenance" data-gallery-provenance aria-label="Gallery catalog and contract provenance">
  <details>
    <summary>Catalog, projection, and contract provenance</summary>
    <dl class="demo-facts">
      <dt>Catalog</dt><dd><code>${escapeHtml(catalog.package)}</code> <code>${escapeHtml(
        catalog.version,
      )}</code> · <code>${escapeHtml(catalog.format)}</code> schema ${escapeHtml(catalog.schemaVersion)}</dd>
      <dt>Projection</dt><dd><code>${escapeHtml(projection.format)}</code> schema ${escapeHtml(
        projection.schemaVersion,
      )}</dd>
      <dt>Contract</dt><dd>producer <code>${escapeHtml(
        contract.producer,
      )}</code> · consumer <code>${escapeHtml(
        contract.consumer,
      )}</code> · executable owner <code>${escapeHtml(
        contract.executableSourceOwner,
      )}</code> · presentation owner <code>${escapeHtml(contract.presentationOwner)}</code></dd>
    </dl>
  </details>
</aside>`;
}

function renderCard(card, resolveSourceLink) {
  const { sample } = card;
  const source = resolveSourceLink(sample);
  const sourceLabel = source.kind === "guide" ? "Read the walkthrough" : "View source";
  const dataSummary = [
    `mode <code>${escapeHtml(sample.data.mode)}</code>`,
    `auth <code>${escapeHtml(sample.data.authMode)}</code>`,
    `configuration <strong>${escapeHtml(sample.data.configurationStatus)}</strong>`,
  ];
  const headingId = `sample-${encodeURIComponent(sample.id)}-title`;
  const configurationNote = sample.data.configurationGap
    ? `<dt>Configuration note</dt><dd>${escapeHtml(sample.data.configurationGap)}</dd>`
    : "";

  return `<article class="demo-card demo-card--${escapeHtml(sample.lifecycle.state)}" id="sample-${escapeHtml(
    encodeURIComponent(sample.id),
  )}" aria-labelledby="${escapeHtml(headingId)}" data-gallery-card data-sample-id="${escapeHtml(
    sample.id,
  )}" data-gallery-search-text="${escapeHtml(card.searchText)}" data-gallery-capabilities="${escapeHtml(
    JSON.stringify(sample.capabilities),
  )}" data-gallery-protocols="${escapeHtml(JSON.stringify(sample.protocols))}">
  <header class="demo-card-header">
    <h3 id="${escapeHtml(headingId)}">${escapeHtml(sample.title)}</h3>
    <div class="demo-badges" aria-label="Support and lifecycle">
      <span class="demo-badge">Support · ${escapeHtml(sample.supportTier)}</span>
      <span class="demo-badge demo-badge--lifecycle">Lifecycle · ${escapeHtml(sample.lifecycle.state)}</span>
    </div>
  </header>
  <p class="demo-id"><code>${escapeHtml(sample.id)}</code></p>
  <p class="demo-summary">${escapeHtml(sample.summary)}</p>
  <a class="demo-link" href="${escapeHtml(source.href)}">${sourceLabel} →</a>
  <dl class="demo-facts demo-facts--essential">
    <dt>SDK</dt><dd><code>${escapeHtml(sample.sdk.package)}</code> <code>${escapeHtml(sample.sdk.version)}</code></dd>
    <dt>Data</dt><dd>${dataSummary.join(" · ")}</dd>
    <dt>Evidence state</dt><dd>${renderEvidenceSummary(sample)}</dd>
    <dt>Replacement</dt><dd>${renderReplacement(card.replacement)}</dd>
    <dt>Capabilities</dt><dd>${renderTags(sample.capabilities, `${sample.title} capabilities`)}</dd>
    <dt>Protocols</dt><dd>${renderTags(sample.protocols, `${sample.title} protocols`)}</dd>
  </dl>
  <details class="demo-card-details">
    <summary>Evidence, provenance, lifecycle, and degradation</summary>
    <dl class="demo-facts demo-facts--details">
      <dt>Lifecycle</dt><dd>${renderLifecycle(sample)}</dd>
      ${configurationNote}
      <dt>Data provenance</dt><dd>${escapeHtml(sample.data.provenance)}</dd>
      <dt>Attribution</dt><dd>${escapeHtml(sample.data.attribution)}</dd>
      <dt>Freshness</dt><dd>${escapeHtml(sample.data.freshness)}</dd>
      <dt>Evidence details</dt><dd>${renderEvidenceDetails(sample)}</dd>
      <dt>Expected degradation</dt><dd>${escapeHtml(sample.expectedDegradation)}</dd>
      <dt>Renderers</dt><dd>${renderTags(sample.renderers, `${sample.title} renderers`)}</dd>
      <dt>Golden journey</dt><dd>${renderJourney(card.journey)}</dd>
      <dt>Validation profile</dt><dd><code>${escapeHtml(sample.validationProfile)}</code></dd>
    </dl>
  </details>
</article>`;
}

/** Render only the gallery's main content; the docs builder owns site chrome. */
export function renderGalleryContent(gallery, { resolveSourceLink } = {}) {
  const sourceLink =
    resolveSourceLink ??
    ((sample) => ({
      href: sample.source.docsPath,
      kind: "source",
    }));
  const capabilityOptions = gallery.filters.capabilities.map(renderOption).join("");
  const protocolOptions = gallery.filters.protocols.map(renderOption).join("");
  const groups = gallery.groups
    .map(
      (group) => `<section data-gallery-group aria-labelledby="gallery-${escapeHtml(group.track)}">
  <h2 id="gallery-${escapeHtml(group.track)}">${escapeHtml(group.title)}</h2>
  <div class="demo-grid">
${group.cards.map((card) => renderCard(card, sourceLink)).join("\n")}
  </div>
</section>`,
    )
    .join("\n");

  return `<h1>Demo gallery</h1>
<p>Runnable examples projected from the versioned SDK sample catalog. Public recipes
and labs appear here now; qualified golden journeys join automatically as their
evidence gates pass. Cards retain lifecycle, degradation, and evidence truth even
when a sample is scheduled for replacement or retirement.</p>
${renderGalleryProvenance(gallery)}
<form class="gallery-controls" data-gallery-controls role="search" aria-label="Filter demo gallery">
  <div class="gallery-control">
    <label for="gallery-search">Task or sample</label>
    <input id="gallery-search" type="search" autocomplete="off" placeholder="Try editing, realtime, or imagery" data-gallery-search />
  </div>
  <div class="gallery-control">
    <label for="gallery-capability">Capability</label>
    <select id="gallery-capability" data-gallery-capability><option value="">All capabilities</option>${capabilityOptions}</select>
  </div>
  <div class="gallery-control">
    <label for="gallery-protocol">Protocol</label>
    <select id="gallery-protocol" data-gallery-protocol><option value="">All protocols</option>${protocolOptions}</select>
  </div>
  <button type="button" data-gallery-clear disabled>Clear filters</button>
</form>
<p class="gallery-results" role="status" aria-live="polite" aria-atomic="true"><strong data-gallery-result-count>${escapeHtml(
    gallery.cardCount,
  )}</strong> of ${escapeHtml(gallery.cardCount)} public samples</p>
<p class="gallery-empty" data-gallery-empty hidden>No public samples match these filters. Clear a filter or try a broader task.</p>
${groups}`;
}
