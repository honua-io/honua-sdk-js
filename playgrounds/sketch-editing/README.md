# Interactive sketch editing with terra-draw — zero-install playground

<!-- Generated from examples/sketch-editing by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

terra-draw draw modes drive the edit-sketch workflow: undo/redo, snapping, and applyEdits submission.

- [Open in StackBlitz](https://stackblitz.com/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/sketch-editing)
- [Open in CodeSandbox](https://codesandbox.io/s/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/sketch-editing)

## Run it locally

```bash
npm install
npm run dev
```

This project carries the same committed source as
[`examples/sketch-editing`](../../examples/sketch-editing), with one difference: it resolves
`@honua/sdk-js` from the published package instead of the repository's `src/` tree, so it
runs anywhere npm does — including a browser playground. Its data comes from its own committed
source, so the default lane needs no account, no key, and no third-party request.

Edit the sample in `examples/sketch-editing` and run `npm run samples:playgrounds:generate`;
editing this copy directly fails `npm run samples:playgrounds:check`.
