# STAC imagery browser — zero-install playground

<!-- Generated from examples/stac-imagery-browser by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

Searches Maui imagery by bounds and time, renders a selected preview, and inspects a signed PMTiles v3 handoff.

- [Open in StackBlitz](https://stackblitz.com/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/stac-imagery-browser)
- [Open in CodeSandbox](https://codesandbox.io/s/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/stac-imagery-browser)

## Run it locally

```bash
npm install
npm run dev
```

This project carries the same committed source as
[`examples/stac-imagery-browser`](../../examples/stac-imagery-browser), with one difference: it resolves
`@honua/sdk-js` from the published package instead of the repository's `src/` tree, so it
runs anywhere npm does — including a browser playground.

## Where its data comes from

Its own committed source, so the default lane needs no account, no key, and no third-party request.

Edit the sample in `examples/stac-imagery-browser` and run `npm run samples:playgrounds:generate`;
editing this copy directly fails `npm run samples:playgrounds:check`.
