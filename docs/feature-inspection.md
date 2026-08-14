# Feature inspection

`@honua/sdk-js/web-components` provides one inspection workflow for a map hit,
feature search result, or table row. The workflow keeps source-qualified
feature identity, authoritative details, overlapping-result navigation,
attachments, related records, selection, cache scope, and realtime freshness
in one public contract.

```ts
import {
  createHonuaFeatureInspectionFromApplicationContext,
  defineHonuaFeatureInspection,
} from "@honua/sdk-js/web-components";

defineHonuaFeatureInspection();

const inspection = createHonuaFeatureInspectionFromApplicationContext(appContext, {
  presentation: {
    titleField: "NAME",
    fields: ["STATUS", "REPORTED_AT", "ADDRESS"],
    links: [{ label: "Incident report", hrefField: "REPORT_URL" }],
  },
  searchFields: ["NAME", "ADDRESS"],
  relationships: [{ id: 0, label: "Assigned units", outFields: ["UNIT", "STATUS"] }],
  attachmentHref: (attachment, target) =>
    `/api/incidents/${encodeURIComponent(String(target.id))}/attachments/${encodeURIComponent(String(attachment.id))}`,
  baseHref: location.href,
  allowedLinkOrigins: [location.origin],
  budgets: { pageSize: 10, maxPages: 5, maxOverlappingResults: 25 },
});

const details = document.querySelector("honua-feature-inspection");
details.inspection = inspection;

map.on("click", async (event) => {
  const hits = map.queryRenderedFeatures(event.point).map((hit) => ({
    target: {
      sourceId: String(hit.source),
      sourceLayer: hit.sourceLayer,
      id: hit.id,
    },
  }));
  await inspection.openFromMapClick(hits);
});

table.addEventListener("honua-row-activate", (event) => {
  void inspection.openFromTableRow({ target: event.detail.target });
});
```

`mountHonuaApplication()` assigns its application context directly to
`<honua-feature-inspection>`. In that mode, selection opened by the component
is written to the shared context, and a source-qualified selection written by a
map or table opens the same details contract. Source or authorization
replacement creates a new inspection scope before cached data can appear for a
different principal.

## Capability and query behavior

The workflow reads `Source.descriptor.schema` and effective
`Source.capabilities` before issuing work:

- details request only the primary key, title, configured display fields, and
  configured link fields;
- server search requests only configured searchable fields and a bounded page;
- attachments and related records run only when `attachments` and
  `queryRelated` are advertised and the host supplies `loadAttachmentPage` or
  `loadRelationshipPage`, respectively. Those adapters receive an explicit
  `offset`, `limit`, and `AbortSignal` and must enforce the window upstream;
- unavailable operations produce typed, actionable inspection diagnostics;
- overlapping results, stored attachment results, relationship results, fields,
  search sources, and cache entries all have explicit budgets.

Detail and search caches use separate TTLs. Detail identity includes source,
typed feature ID, source layer, requested fields, relationship shape,
credential-free authorization scope, and source/application version. A
superseding open or search aborts the previous request and ignores any late
completion.

The canonical `AttachmentApi.list` and `RelatedQuery` contracts do not yet
carry pagination parameters. Inspection therefore never calls those unbounded
methods as a fallback. It emits `attachments-unbounded` or
`relationships-unbounded` and withholds the subfeature until a protocol-aware
bounded loader is configured. Results that exceed the requested limit are
truncated defensively and diagnosed.

These TTL caches are controller-local. `HonuaApplicationContext` owns
in-flight request cancellation/deduplication but deliberately does not retain
result pages, so there is not yet a compatible public shared result-cache
contract for inspection to adopt.

## Safe popup content and links

Popup descriptions are templates that interpolate attribute values into plain
text. Source HTML is stripped and the component escapes the result before it
reaches the DOM. Arcade expressions are never evaluated; declaring one adds a
`popup-arcade-unsupported` diagnostic so an application can replace it with a
server-computed field or explicit application code.

Only absolute or explicitly based HTTP(S) URLs are accepted. URLs containing
username/password credentials, unsafe schemes, disallowed origins, and URL
fragments are withheld. Rendered external and attachment links always use
`target="_blank" rel="noopener noreferrer"`; the inspection component does not
fetch them and therefore cannot forward source authorization to another
origin.

## Realtime and deletion

Call `inspection.applyRealtime()` for a selected feature. A complete record can
replace the open details. A partial update is patched only when it names every
changed field and those fields are loaded. Ambiguous updates mark the view
`stale` and expose `refresh()`. Deletes transition to `deleted` explicitly and
remove attachments and relationships instead of leaving an apparently valid
popup open.

The custom element exposes a polite live region, labelled search and paging
navigation, keyboard-reachable controls, Escape dismissal with focus
restoration, responsive 320 px layout, reduced-motion behavior, and
forced-colors borders. Set `presentation="popup"` to expose the details region
as a non-modal dialog; the underlying inspection state is identical to the
panel presentation.
