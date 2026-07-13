# Temporal playback demo

Animates a month of synthetic seismic events with `createTemporalPlayback`
from `@honua/sdk-js/map`, styled by a first-class `classBreaksRenderer` from
`@honua/sdk-js/style` (issue #497). The legend derives from
`renderer.legendItems()`.

The fixture is generated in the browser from a seeded PRNG — a fully
deterministic mock lane with no network access and no realtime dependency.
Playback drives client-side MapLibre layer filters (`["all", <base>,
[">=" time], ["<" time]]`) composed with the layer's bind-time filter.

```bash
npm run demo:temporal-playback           # dev server
npm run demo:temporal-playback:build     # production build
npm run demo:temporal-playback:typecheck
```

Controls: play/pause, a scrub slider over the 30-day extent, and a window
length selector (1/3/7 days). `window.__temporalPlaybackState` exposes
`{ ready, playing, windowStart, windowEnd, visibleCount, ticks }` for smoke
checks.
