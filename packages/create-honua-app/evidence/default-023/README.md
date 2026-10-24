# Published default scaffold 0.2.3 evidence

The actual registry-only default CLI installed SDK 0.2.6, built both generated
templates, and rendered a MapLibre canvas with four rendered feature records,
zero console errors and zero off-origin requests. These records are not asserted
to be unique source rows. The served map uses the starter's owned fixture; this
does not qualify an installed server or an authenticated Console journey.

The combined result is **failed**. Vanilla completed in 105,799 ms against the
unchanged 120,000 ms budget. React rendered successfully but took 154,914 ms,
including 106,164 ms for its clean app installation and 22,339 ms for its build.
The initial vanilla attempt also remains failed: missing `libnspr4.so` prevented
the browser launch and elapsed time was 147,466 ms. Nothing here erases that run.

The rerun changed only the runtime library path to the existing Ubuntu packages.
Node 22.23.3, Playwright 1.58.2 and Chromium 145.0.7632.6 were observed. The actual
WebGL2 preflight, browser/library hashes and package provenance are retained.
The source, harness and execution configurations remained unchanged while the
original admitted process ran. `admission-result.json.raw` retains its exit and
source comparison; the successful runtime preflight does not change the failed
combined product verdict.

Each attempt retains original command logs, registry/provenance records, generated
package, both consumer lockfiles, observed default selection, raw receipt and
executed helper bytes. Raw JSON and JavaScript use an archival `.raw` suffix so
formatters do not change their recorded hashes. `files.sha256.json` binds those
original bytes. The receipt's package integrity hashes identify the npm tarballs;
the original downloaded tarballs are retained with the local run artifacts.

The independent published sources are SDK `45e2fb2c7c35216521319f0e3447661988f2981f`
and scaffold `c7d517b0dd12842ed31161d77dd0114abfee2673`. The harness producer was
`bd178cf762574379c8c0cfe6e923fe9a39ce9832`. Every app used fresh npm caches, empty
user/global configuration and normal peer resolution, with no SDK override,
workspace dependency, force flag or locally rebuilt product tarball.

For a separate hosted observation, dispatch `create-honua-app-live.yml` with
`published_default=true` and leave both override inputs empty. That mode verifies
the recorded cohort against the public registry, runs both templates on separate
fresh runners using the byte-identical strict harness, and uploads original inputs,
tarballs, command logs and receipts even on failure. It retains the 120-second
measurement. Its result remains pending; this archive makes no hosted-pass claim.
