---
type: guide
title: "JavaScript migration tool transition"
description: "The JavaScript migration engine moved to the honua-migrate repository and npm package. What changed, where the code went, and what to install instead."
resource: "https://www.npmjs.com/package/@honua/honua-migrate"
---
# JavaScript migration tool transition

The JavaScript migration engine and npm package now live in
[`honua-io/honua-migrate`](https://github.com/honua-io/honua-migrate). Install
`@honua/honua-migrate` and use the JavaScript-specific executable:

```sh
npm install --save-dev @honua/honua-migrate
npx honua-js-migrate scan ./src
npx honua-js-migrate codemod ./src --write --report migration-report.json
```

Existing imports from `@honua/sdk-js/migration` remain valid and forward to
`@honua/honua-migrate`. The SDK's `scan:arcgis`, `scan:arcgis:widgets`, and
`migrate:arcgis` npm scripts also delegate to the new executable. Both
compatibility paths write a deprecation notice to stderr without changing
stdout, exit status, or migration artifacts.

The forwarders will remain for at least two consecutive `honua-migrate` minor
releases and 90 days. They will not be removed before `honua-migrate` 1.2.

The canonical Python executable remains `honua-migrate`; the JavaScript
executable is `honua-js-migrate`, avoiding a global command-name collision.

## Release verification

From an SDK source checkout, `npm run verify:migration-cohort` builds and packs
the SDK, installs it into a fresh consumer using npm's default resolver, and
checks its published migration dependency. The check compares installed export
identity and CLI output, verifies that the migrator and compat package resolve
the same SDK, and rejects nested packages from an incompatible SDK generation.

After SDK publication, `npm run verify:migration-cohort:registry` performs the
same checks with every package installed from the public registry. This is the
published-consumer proof; the packed check is prepublication evidence. Both
retain `test-results/migration-cohort.json` and its companion lockfile, including
installed versions, integrity, release source/provenance checks, and failures.
The publication workflow requires both stages, and the scheduled client-pin
workflow repeats the registry stage. The existing sibling-source tarball test
remains a separate development check.

For guarded branch-recovery publications, the publication workflow supplies its
authenticated ref through `--sdk-publish-ref`. Scheduled and manual replays
first require the normal release-tag proof. If an SDK package fails only the
ref/source check, they authenticate the exact GitHub publisher run attempt
named by its provenance: canonical repository/workflow, release-tag source
commit, matching branch, successful guarded publication, and a skipped dry-run
summary. They then repeat the full registry verification with that branch ref
and retain the run identity. Missing or contradictory run evidence fails; it
never authorizes an arbitrary ref. Each older SDK dependency is verified against
its own release identity, and the migrator retains its separate release-tag
check. The publisher's immediate check still supplies its own ref because that
run has not finished yet.
