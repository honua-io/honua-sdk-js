# Installed-package certification

`npm run certify:installed-package` is the hard 2026.1 client/server gate. It creates a clean temporary consumer,
installs only public `@honua/sdk-js@0.1.9-beta.0` registry bytes with `npm ci`, verifies the lockfile's registry URL and
SHA-512 integrity, and binds the receipt to the exact candidate image digest.

The lane consumes operation observations with `--observations <json>`; each item names a frozen denominator `id` and
a `pass`, `fail`, or `blocked` verdict. Missing required observations become explicit `blocked` rows with an owned
`blockedBy` coordinate. The command exits nonzero unless every one of the 228 supported rows passes. Its JSON artifact
is suitable for the `honua-release#233` compatibility-ledger row because it records package coordinate/version,
registry integrity, server digest, all operation verdicts, and a canonical receipt digest.

The scheduled workflow uploads the receipt even when the gate fails, so a missing or unpublished operation can never
appear as a silent skip.

`npm run certify:installed-examples` reuses that same clean install and image-identity check. It enumerates every
top-level example directory and every JavaScript/TypeScript documentation fence. Examples that expose the shared
packed-package Vite mode are built from the installed public exports; examples that still resolve repository source
are explicit `blockedBy` rows. Compile-directed documentation snippets are checked against the installed package,
while fences deliberately labeled `doc-test=skip` remain visible as `not-executable` rather than being counted as
passes. An executed failure must carry a filed defect coordinate and fails the workflow.
