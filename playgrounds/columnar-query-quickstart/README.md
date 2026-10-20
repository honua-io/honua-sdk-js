# Map a bounded Arrow result — zero-install playground

<!-- Generated from examples/columnar-query-quickstart by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

Executes an exact Honua Server Arrow fixture through bounded pushdown, decoding, cancellation, evidence, and a deterministic MapLibre handoff.

- [Open in StackBlitz](https://stackblitz.com/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/columnar-query-quickstart)
- [Open in CodeSandbox](https://codesandbox.io/s/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/columnar-query-quickstart)

## Run it locally

```bash
npm install
npm run dev
```

This project carries the same committed source as
[`examples/columnar-query-quickstart`](../../examples/columnar-query-quickstart), with one difference: it resolves
`@honua/sdk-js` from the published package instead of the repository's `src/` tree, so it
runs anywhere npm does — including a browser playground.

## Where its data comes from

Its own committed source, so the default lane needs no account, no key, and no third-party request.

Edit the sample in `examples/columnar-query-quickstart` and run `npm run samples:playgrounds:generate`;
editing this copy directly fails `npm run samples:playgrounds:check`.
