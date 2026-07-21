# Honua sample design language

The shared visual identity for every sample app (issue #734, REQ-001). One token
sheet, one component layer, no per-sample palettes. Open `style-guide.html` in a
browser (no server needed) to review every primitive in both themes.

## Consume it

```ts
// In a sample's entry module (Vite inlines the imports at build time):
import "../../_kit/design/index.css";
```

Add `class="hn-app"` to `<body>`. Theme follows the OS; stamp
`data-theme="light" | "dark"` on `<html>` to override (the stamp always wins,
and a stamped subtree re-themes locally). SDK web components pick the theme up
automatically — the sheet bridges the `--honua-ui-*` hooks used by
`src/web-components` and `src/controls`.

## Identity: the field instrument

Honua is Hawaiian for earth. The samples are instruments for reading the earth,
so the identity borrows from the tools of that trade — survey quads, chart
paper, instrument readouts — rather than dashboard fashion:

- **Surfaces:** cool "chart paper" neutrals in light, "basalt" green-cast darks
  in dark. Both carry a barely-there green cast; neither is gray, cream, or
  pure black. The basemap stays the stage; saturation belongs to data.
- **One accent:** Honua green (`#0b6b4d` light / `#43c68f` dark). It marks the
  primary action, focus, selection, and the signature — nothing else.
- **The register voice:** a monospace microtype style (11px, uppercase,
  letterspaced) for everything the UI *reads out* — coordinates, field labels,
  table headers, badges, axis ticks. This is the identity carrier; prose never
  uses it, and it never uses color for meaning.
- **The signature:** neatline corner ticks on floating map panels, as on a
  survey quad's map collar. It appears only on `.hn-panel--floating` — spend
  the boldness once, keep everything else quiet.

## Token reference (`tokens.css`)

| Group | Tokens |
|---|---|
| Type | `--hn-font-ui`, `--hn-font-display`, `--hn-font-mono`; sizes `--hn-text-register` (11) → `--hn-text-display`; `--hn-tracking-*`, `--hn-leading-*` |
| Space / shape | `--hn-space-0..8` (2→64px, 4px grid); `--hn-radius-sm|(base)|lg|pill`; `--hn-control-height(-lg)` |
| Surfaces | `--hn-page`, `--hn-surface`, `--hn-surface-raised`, `--hn-surface-sunken`, `--hn-surface-float` |
| Ink | `--hn-ink`, `--hn-ink-secondary`, `--hn-ink-muted` (AA floor), `--hn-ink-faint` (non-text only) |
| Lines | `--hn-line` (hairline), `--hn-line-strong` (panel edge), `--hn-border-control` (3:1 non-text) |
| Accent | `--hn-accent`, `--hn-accent-ink`, `--hn-accent-wash`, `--hn-link`, `--hn-focus` |
| Elevation / motion | `--hn-shadow-1..3`, `--hn-blur`, `--hn-scrim`; `--hn-motion-fast|(base)|slow`, `--hn-ease` (0ms under reduced motion) |
| Status | badge pairs `--hn-{ok,warn,serious,critical,info,neutral}-{text,tint}`; fixed marks `--hn-status-*` |
| UI charts | `--hn-series-1..8`, `--hn-viz-surface|grid|axis` |
| Cartography | ramps `--hn-carto-cat-1..10`, `--hn-carto-safe-1..10`, `--hn-seq-warm-1..7`, `--hn-seq-cool-1..7`, `--hn-div-1..7`, `--hn-viridis-1..7`; basemap `--hn-basemap-{land,water,line,label}`, `--hn-halo` |
| SDK bridge | `--honua-ui-{bg,surface,fg,muted,border,accent,accent-fg}` mapped from the above |

Fonts are system stacks only — samples run network-isolated under
qualification, so no webfonts, no CDNs:

- Display: `"Avenir Next", "Seravek", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`, weight 650, tight tracking.
- UI/body: `system-ui, "Segoe UI", "Helvetica Neue", Arial, sans-serif`.
- Register/data: `ui-monospace, "SF Mono", "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace`; `tabular-nums` wherever numbers align.

## Component classes (`components.css`)

Shell `.hn-app`, `.hn-skip-link`, `.hn-sr-only` · type `.hn-display/h1/h2/h3`,
`.hn-lead`, `.hn-register`, `.hn-eyebrow`, `.hn-coord`, `.hn-code` · panels
`.hn-panel` (+`-header/-title/-body/-footer`, `--floating`, `--sunken`) ·
`.hn-toolbar` (+`-group`, `-sep`) · `.hn-btn` (`--primary --quiet --danger
--sm --icon`) · forms `.hn-field` (+`-label/-hint/-error`), `.hn-input`,
`.hn-select`, `.hn-textarea` · `.hn-badge` (`--ok --warn --serious --critical
--info --outline`), `.hn-chip` · `.hn-table-wrap`, `.hn-table` (+`.is-num`) ·
`.hn-popup` (+MapLibre popup adoption), `.hn-tooltip` · map `.hn-map-stage`,
`.hn-map-slot--{corner}`, `.hn-attribution`, `.hn-scalebar`, `.hn-canvas-text`,
`.hn-legend` (+`-row/-swatch/-range`) · `.hn-stat` (+`-label/-value/-delta`) ·
states `.hn-empty`, `.hn-error-state`, `.hn-loading`, `.hn-spinner`,
`.hn-skeleton`, `.hn-message--*` · viz scaffolding `.hn-viz` (+`-title`,
`-legend`, `-axis-label`).

## Usage rules for sample authors

1. Import `index.css`, then write **layout** CSS only. If a sample needs a new
   color, spacing value, or font size, it goes in this package or not at all.
2. One `--primary` button per view; it names the action ("Run query", not
   "Submit") and keeps that name through the flow.
3. Floating map panels use `.hn-panel--floating` inside `.hn-map-slot--*`
   (12px canvas margins; no furniture overlap at ≥360px width). Opaque
   sidebars butted against the canvas are not the house style.
4. Status is never color alone: badges carry labels, marks pair icon + text.
5. Empty/loading/error states are required, and they direct: what happened,
   what to do next. Errors never apologize and never say "something went wrong".
6. The register voice (`.hn-register`, field labels, table headers) is for data
   readouts only — never prose, never headings.
7. Charts: series colors only from `--hn-series-*` in fixed slot order, never
   cycled or re-assigned on filter; a legend whenever ≥2 series; text in ink
   tokens, never series colors; one axis, never dual-axis. Light-theme slots
   3/4/5 sit below 3:1 on the surface — give those series direct labels or a
   table view.
8. Respect the tokens' motion: transitions use `--hn-motion*`; anything that
   loops (spinner, shimmer) must degrade under `prefers-reduced-motion`.

## Cartography rules

The map itself follows the same discipline (survey of Esri/Mapbox/CARTO/Felt/
Protomaps practice; only openly licensed values are shipped):

- **Basemap as stage.** Use the `--hn-basemap-*` tokens for hand-rolled fixture
  styles or a Honua Protomaps flavor: land = app surface shifted a step, water
  cooler and darker than land, labels in secondary ink. Dark mode is a
  redesign, not an inversion — land `#1a201d`, never `#000`, water darker than
  land so landmasses stay figure.
- **Thematic layers use the carto ramps, not the UI chart series:** Prism
  categorical (Safe as the colorblind-verified alternative), SunsetDark/Teal
  sequential, Temps diverging, viridis for heatmaps/continuous. ≤6–7
  categorical hues at once; choropleths default to 5 quantile classes;
  diverging ramps only for data with a true midpoint; on dark basemaps prefer
  viridis for heatmaps and flip sequential ramps so high = bright.
- **Halo every text run over the canvas** (`.hn-canvas-text`, or the style
  layer's halo in `--hn-halo`): 1–1.5px in the local basemap tone.
- **Furniture:** attribution bottom-right, 10px quiet pill, never removed;
  scale bar bottom-left, thin; legend card capped at 260px with the layer's
  actual paint colors and en-dash numeric ranges; popups 280–320px with
  humanized field names (`pop_2020` → "Population (2020)"); hover tooltip for
  the one-liner, click popup for detail.

**Never ship:** rainbow/jet ramps on ordered data · saturated basemaps under
choropleths · unhaloed canvas labels · default-marker "Leaflet soup" or pin
overload instead of clustering · 8+ simultaneous categorical hues · pure
`#000`/`#fff` canvas with 100%-saturation overlays in dark mode · a diverging
ramp on all-positive data (or sequential on ± data) · equal-interval bins on
skewed data · red/green distinctions with no redundant channel · labels under
thematic fills · missing attribution or a legend that doesn't match the layer.

### Palette attribution

> Thematic map ramps include CARTOColors (© CARTO, CC-BY-4.0,
> https://carto.com/carto-colors/) and the viridis colormap (CC0). Keep this
> notice in any derived docs. No Mapbox-, Esri-, or Stamen-NC-derived values
> are used anywhere in this package.

## Accessibility

WCAG AA verified by computation (WCAG 2.x relative-luminance ratios), both themes:

| Pair | Light | Dark |
|---|---|---|
| `ink` on `surface` / `page` | 16.3 / 15.0 | 14.6 / 15.9 |
| `ink-secondary` on `surface` | 7.7 | 8.7 |
| `ink-muted` on `surface` / `page` | 5.3 / 4.9 | 6.5 / 7.1 |
| `accent` as text on `surface` | 6.4 | 8.0 |
| `accent-ink` on `accent` (primary button) | 6.5 | 7.9 |
| badge text on tint (worst of six) | 5.4 (info) | 7.2 (critical) |
| `border-control` on `surface` (non-text, ≥3:1) | 3.6 | 3.1 |
| focus ring on `page` (non-text, ≥3:1) | 5.9 | 8.7 |

- Focus: universal 2px `--hn-focus` outline, offset 2px, on `:focus-visible`
  inside `.hn-app` — never remove it; buttons/toolbars keep ≥36px hit targets.
- `--hn-ink-faint` and hairline `--hn-line` are decorative-only: never put text
  in them.
- Chart series (`--hn-series-*`) passed the dataviz six-check validator on
  these exact surfaces: light — CVD worst-adjacent ΔE 9.1, normal-vision 19.6;
  dark — CVD 8.4, normal-vision 19.3; all dark slots ≥3:1 vs `#151c18`.
- Reduced motion: all `--hn-motion*` durations collapse to 0ms; the skeleton
  shimmer stops; the spinner slows.
- Skip link + `aria` patterns are demonstrated in `style-guide.html`; keep
  `aria-pressed` on toggle chips/tools and `aria-selected` on table rows.
