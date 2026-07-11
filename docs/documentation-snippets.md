# Documentation snippet validation

JavaScript, JSX, TypeScript, and TSX fences in the root README, installation
guide, `docs/`, example READMEs, and SDK skills are supported code by default.
`npm run docs:snippets:verify` builds the SDK, checks every fence for syntax,
and verifies imports from `@honua/sdk-js` against the package's built public
declarations. The equivalent split-package imports for React, geometry, Esri
compatibility, and migration are checked against the same declarations. CI runs
the same check after its normal build.

Keep examples syntactically complete even when host-defined values are omitted.
The validator reports the Markdown file and opening-fence line when a package
path or named export becomes stale.

Pseudocode, type fragments, historical contracts, and intentionally incomplete
examples must put `doc-test=skip` and a quoted `reason` in the opening fence's
info string. For example, use the info string
`ts doc-test=skip reason="abbreviated host integration"`. Skips without a
reason fail validation, making unsupported code explicit during review.

Generated documentation, dependencies, and build output are excluded because
their canonical inputs have separate freshness gates.
