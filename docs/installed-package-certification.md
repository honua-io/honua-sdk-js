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

The OGC Processes slice reuses this same clean install, lockfile integrity check, image inspection, denominator
projection, and receipt digest through `npm run certify:installed-ogc-processes`. Its observation callback executes
the governed `geometry.buffer` process through the installed package and emits the detailed candidate qualification
beside the shared receipt. The slice fails for a live execution defect, but unrelated denominator cells stay
explicitly blocked in the shared `not-certified` receipt instead of turning a passing OGC operation into a claim that
the entire release is certified.
