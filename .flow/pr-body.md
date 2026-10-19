fix(deps): patch dev-dependency advisories and document every action pin

## Summary

This clears the remaining supply-chain findings on trunk that need no application-code changes.

- **Dependabot #106 / #101:** in `mcp/package-lock.json`, `vitest` and `@vitest/coverage-v8` go from 4.1.0 to 4.1.11, matching the root lock. This fixes GHSA-82fw-gwwq-j7x9. The `mcp` devDependency floor moves to `^4.1.11` so a fresh resolve cannot regress.
- **Dependabot #114 and Scorecard Vulnerabilities (#31):** in the root `package-lock.json`, `brace-expansion` goes from 2.1.4 to 2.1.7 (GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr) and `fast-uri` from 3.1.7 to 3.1.8 (GHSA-hrr3-gc8f-f4qj). Both stay inside their parents' existing ranges.
- **Org pin checker:** honua-release `tools/check_action_pins.py` rejected nine workflow pins. They now carry the version label the rest of the repo uses for the same SHA (upstream tags confirm each SHA is a `v7` release). The untagged honua-release `candidate-input` pin is labelled with its `git describe`. No SHA changes.

Every package touched is development-only.

## Validation

- Every tracked `package-lock.json` scanned for the advisory ranges finds 0 vulnerable entries.
- `npm audit` (root) and `npm audit --omit=dev` (mcp) both report 0 vulnerabilities.
- Native Windows run of the CI `MCP SDK` job sequence: root `npm ci` + `npm run build`, then mcp `npm ci`, `npm run typecheck`, `npm run check` and `npm test`. Result: 642 passed, 1 failed, 4 skipped. The one failure is `test/entrypoint.test.ts` symlink creation hitting `EPERM` (Windows needs symlink privilege). That is environmental and unrelated to the vitest bump; Linux CI is the authority.
- `npm ls`: `vitest`, `@vitest/coverage-v8` and `@vitest/mocker` resolve to 4.1.11, `brace-expansion` to 2.1.7, `fast-uri` to 3.1.8.
- actionlint 1.7.12 and the honua-release pin checker (trunk 9aa50db) both pass on all workflows.
- `git diff --check` passes.

Notes:
- The mcp lock was regenerated with npm 11.21.1. npm 11.5.1 crashes with `Cannot read properties of null (reading 'edgesOut')` on the `file:..` link. The vitest 4.1.11 subtree pulled matching transitive updates (vite 8.3.4, rolldown 1.2.14, which drops its wasm binding), the same tree the root lock already uses.
- In the root lock, npm pruned an extraneous hoisted `@turf/distance` 7.3.5. Its three dependents already resolve nested 7.4.0 copies.
- The golden-sample receipts digest `package-lock.json`. PR CI relaxes that check, and the derived-artifact workflow reseals it on trunk after merge.

Out of scope (application code): CodeQL #368 `js/insufficient-password-hash` in `mcp/src/agent/local-runtime.ts`. The open alert counts on trunk 69a16ab are 5 code-scanning and 3 Dependabot. Scorecard and Dependabot re-evaluate after merge. No alert was dismissed.

## Issue disposition

Closes #2173
