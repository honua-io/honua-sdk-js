# Safe Agent Workbench — zero-install playground

<!-- Generated from examples/ai-spatial-app-builder by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

Proves typed proposals, shared policy validation, signed single-use approval, bounded execution, refusal, and verified receipt states.

- [Open in StackBlitz](https://stackblitz.com/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/ai-spatial-app-builder)
- [Open in CodeSandbox](https://codesandbox.io/s/github/honua-io/honua-sdk-js/tree/trunk/playgrounds/ai-spatial-app-builder)

## Run it locally

```bash
npm install
npm run dev
```

This project carries the same committed source as
[`examples/ai-spatial-app-builder`](../../examples/ai-spatial-app-builder), with one difference: it resolves
`@honua/sdk-js` from the published package instead of the repository's `src/` tree, so it
runs anywhere npm does — including a browser playground. Its data comes from its own committed
source, so the default lane needs no account, no key, and no third-party request.

Edit the sample in `examples/ai-spatial-app-builder` and run `npm run samples:playgrounds:generate`;
editing this copy directly fails `npm run samples:playgrounds:check`.
