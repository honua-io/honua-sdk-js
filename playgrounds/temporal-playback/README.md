# Temporal playback — zero-install playground

<!-- Generated from examples/temporal-playback by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

Animates a month of seeded synthetic seismic events with createTemporalPlayback, styled by a first-class classBreaksRenderer whose legend derives from renderer.legendItems().

- [Open in StackBlitz](https://stackblitz.com/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/temporal-playback)
- [Open in CodeSandbox](https://codesandbox.io/s/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/temporal-playback)

## Run it locally

```bash
npm install
npm run dev
```

This project carries the same committed source as
[`examples/temporal-playback`](../../examples/temporal-playback), with one difference: it resolves
`@honua/sdk-js` from the published package instead of the repository's `src/` tree, so it
runs anywhere npm does — including a browser playground.

## Where its data comes from

Its own committed source, so the default lane needs no account, no key, and no third-party request.

Edit the sample in `examples/temporal-playback` and run `npm run samples:playgrounds:generate`;
editing this copy directly fails `npm run samples:playgrounds:check`.
