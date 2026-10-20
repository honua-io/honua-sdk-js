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
| SDKJS-006 | fixed | `test/abort-signal.test.ts` covers stalled bytes, PBF, bounded/unbounded text, metadata, and raw response bodies under deadlines and caller cancellation. Raw responses transfer deadline ownership to the stream and release it on EOF, cancellation, or error without buffering before headers are returned. |
| SDKJS-007 | fixed | `SDKJS-007 rejects a successful non-JSON response instead of treating it as data` in `test/core-client.test.ts` verifies a 200 text body throws `HonuaHttpError`. Additional regressions accept valid JSON with a string `raw` field through the public JSON pipeline and bounded metadata path, while malformed JSON still throws with the raw body preserved; rejection depends on parsing failure, not a response property. |
| SDKJS-008 | fixed | `SDKJS-008 OData nextLink base paths` in `test/contract/odata-conformance.test.ts` verifies an absolute next link under a sub-path base is requested without duplicating the prefix. |
| OData repeated-cursor guard | fixed | `test/query-correctness-audit.test.ts` exercises cyclic links in `queryAll`, `queryStream`, and delta paging, including equivalent relative and absolute links; each drain throws `HonuaHttpError` before requesting the repeated page. |
| Typed temporal-looking string literals | fixed | `test/query-correctness-audit.test.ts` verifies ISO-looking text strings remain quoted in comparisons, lists, and ranges across SQL-92, CQL2, and OData, while date equality/IN/ranges remain typed when source schema or EDM metadata identifies a temporal field. Schema-known temporal fields retain typed literals; schema-free and text-field strings remain quoted. Explicit temporal filter nodes retain typed instant encodings. |
