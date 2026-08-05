# React quickstart — zero-install playground

<!-- Generated from examples/react-quickstart by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

Focused React provider, hooks, and map-component recipe alongside the framework-neutral First Map journey.

- [Open in StackBlitz](https://stackblitz.com/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/react-quickstart)
- [Open in CodeSandbox](https://codesandbox.io/s/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/react-quickstart)

## Run it locally

```bash
npm install
npm run dev
```

This project carries the same committed source as
[`examples/react-quickstart`](../../examples/react-quickstart), with one difference: it resolves
`@honua/sdk-js` from the published package instead of the repository's `src/` tree, so it
runs anywhere npm does — including a browser playground.

## Where its data comes from

`examples/react-quickstart` is served by a Node fixture server the repository runs beside it
(`npm run demo:*:mock`). A browser playground cannot start that process, so this project
serves the same reviewed documents from its own Vite dev and preview server:

- `/api/v1/admin/capabilities` → `fixtures/capabilities.json`
- `/rest/services/natural-earth/FeatureServer/0/query` → `fixtures/features.json`

Every file under `fixtures/` is a byte-identical copy of
[`samples/fixtures/first-map/v1`](../../samples/fixtures/first-map/v1), and `.env` carries the reviewed fixture lane's
configuration. The default lane therefore needs no account, no key, and no third-party request.

Edit the sample in `examples/react-quickstart` and run `npm run samples:playgrounds:generate`;
editing this copy directly fails `npm run samples:playgrounds:check`.
