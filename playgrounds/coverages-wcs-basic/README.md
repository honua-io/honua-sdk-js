# Bounded coverage quickstart — zero-install playground

<!-- Generated from examples/coverages-wcs-basic by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

Renders named-band OGC API Coverages and WCS subsets through one MapLibre image handoff.

- [Open in StackBlitz](https://stackblitz.com/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/coverages-wcs-basic)
- [Open in CodeSandbox](https://codesandbox.io/s/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/coverages-wcs-basic)

## Run it locally

```bash
npm install
npm run dev
```

This project carries the same committed source as
[`examples/coverages-wcs-basic`](../../examples/coverages-wcs-basic), with one difference: it resolves
`@honua/sdk-js` from the published package instead of the repository's `src/` tree, so it
runs anywhere npm does — including a browser playground.

## Where its data comes from

Its own committed source, so the default lane needs no account, no key, and no third-party request.

Edit the sample in `examples/coverages-wcs-basic` and run `npm run samples:playgrounds:generate`;
editing this copy directly fails `npm run samples:playgrounds:check`.
