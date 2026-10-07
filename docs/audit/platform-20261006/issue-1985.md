---
type: reference
title: Query correctness audit record for issue 1985
description: Findings, outcomes, and regression evidence from the 2026-10-06 SDK query correctness audit.
---

# Audit record: issue 1985

| Finding id | Outcome | Evidence |
|---|---|---|
| SDKJS-001 | fixed | `SDKJS-001 parenthesizes every OData predicate before combining OR where and spatial filters` in `test/contract/odata-conformance.test.ts` verifies that each combined predicate is parenthesized. |
| SDKJS-004 | fixed | `SDKJS-004 preserves multipart polylines and polygon exteriors in WKT` verifies multi-path and multi-exterior serialization. `SDKJS-004 assigns polygon holes by containment` in `test/contract/odata-conformance.test.ts` checks exact WKT and WFS surface membership with holes before, between, and after exteriors; shared ring grouping assigns holes to the smallest containing exterior. |
| SDKJS-006 | not attempted | Re-verified in `src/core/client.ts`: unbounded `requestText`, `requestBytes`, binary fallback, cached metadata, and unprepared raw `pipelineFetch` still dispose the deadline at headers. The raw-response ownership design requires a separate, complete change. |
| SDKJS-007 | fixed | `SDKJS-007 rejects a successful non-JSON response instead of treating it as data` in `test/core-client.test.ts` verifies a 200 text body throws `HonuaHttpError`. Additional regressions accept valid JSON with a string `raw` field through the public JSON pipeline and bounded metadata path, while malformed JSON still throws with the raw body preserved; rejection depends on parsing failure, not a response property. |
| SDKJS-008 | fixed | `SDKJS-008 OData nextLink base paths` in `test/contract/odata-conformance.test.ts` verifies an absolute next link under a sub-path base is requested without duplicating the prefix. |
| OData repeated-cursor guard | not attempted | Re-verified in `src/core/odata.ts`: `queryAll`, `queryStream`, and delta paging have no shared repeated-cursor guard. Deferred after the higher-severity findings. |
| Typed temporal-looking string literals | not attempted | Re-verified in `src/contract/query-filter.ts`: temporal-looking strings are inferred without consulting the target field schema. Deferred after the higher-severity findings. |
