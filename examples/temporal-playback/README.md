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

Transport is the app-platform `<honua-time-slider>` element from
`@honua/sdk-js/web-components` (issue #959) bound to the same controller: play
/pause, a WAI-ARIA scrubber over the 30-day extent (arrow keys step one window,
Page Up/Down move ten, Home/End jump to the ends), step buttons, and a speed
selector. The window *length* selector (1/3/7 days) stays a sample control
because it configures the controller rather than driving its transport.
`window.__temporalPlaybackState` exposes
`{ ready, playing, windowStart, windowEnd, visibleCount, ticks }` for smoke
checks.
