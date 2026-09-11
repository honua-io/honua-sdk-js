# Documentation snippet validation

Every JavaScript, JSX, TypeScript, and TSX fence in the root README,
installation guide, `docs/`, example READMEs, and SDK skills must declare
exactly one `doc-test=compile` or `doc-test=skip` directive. The validator uses
the repository's strict TypeScript configuration and real built declarations,
so it checks syntax, assignments, function arguments, static and dynamic
imports, re-exports, and namespace member access. The equivalent split-package
imports for React, geometry, Esri compatibility, and migration resolve to the
same declarations. CI runs the check after its normal build.

Keep examples syntactically complete even when host-defined values are omitted.
The validator reports the Markdown file and opening-fence line when a package
path or named export becomes stale.

Complete snippets use the info string `ts doc-test=compile`. Pseudocode, type
fragments, historical contracts, and intentionally incomplete examples must put
`doc-test=skip` and a nonempty quoted `reason` in the opening fence's info
string. For example, use the info string
`ts doc-test=skip reason="abbreviated host integration"`. Skips without a
reason, unquoted reasons, duplicate directives or attributes, and unknown
directives fail validation, making unsupported code explicit during review.

A complete snippet that only needs shared ambient host declarations may use a
quoted repository-relative prelude, for example
`ts doc-test=compile prelude="docs/snippet-preludes/browser.d.ts"`. Prelude paths
cannot be absolute or traverse outside the repository. Prefer a small typed
prelude over `any`; use a reasoned skip when an excerpt depends on substantial
application context.

Fenced blocks may use the CommonMark allowance of zero to three leading spaces
and may live inside blockquotes. Four-space-indented blocks are ordinary
indented code, not fenced snippets. Generated documentation, dependencies, and
build output are excluded because their canonical inputs have separate
freshness gates.
