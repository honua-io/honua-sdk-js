# Semantic query equivalence corpus

This directory is the protocol-neutral, credential-free compiler corpus shared
by Honua SDKs and Honua Server. Version `1.0` fixes one logical schema, source
rows, semantic query ASTs, normalized expected rows, and a projection decision
for every supported compiler family:

- GeoServices SQL-92
- OGC API Features CQL2 JSON
- WFS 2.0 FES
- OData v4
- DuckDB SQL
- Honua gRPC

The expected result appears once per case. Protocol projections record only
`exact`, `approximate` plus a loss and reason, or `unsupported` plus a
path-addressed diagnostic and reason. A projection must never copy or edit the
expected rows. That makes semantic drift reviewable and prevents each compiler
suite from inventing a different answer.

## Files

- [`v1/schema.json`](./v1/schema.json) is the JSON Schema 2020-12 contract.
- [`v1/corpus.json`](./v1/corpus.json) is the immutable version-1 fixture.
- [`loader.mjs`](./loader.mjs) performs bounded schema validation, cross-field
  invariants, complete protocol-matrix checks, coverage checks, credential
  rejection, cloning, and deep freezing.
- `test/query-planner-semantic-corpus.test.ts` runs every case through every JS
  compiler and independently evaluates the protocol-neutral rows.

Consumers in other languages should validate `corpus.json` against
`schema.json`, apply the same cross-field rules described above, and map the
semantic AST to their own compiler entrypoints. The corpus has no Node-specific
values and needs no network or clock access.

Downstream runners should vendor the complete version directory from an
immutable SDK repository commit or release tag and record its checksum. They
must not fetch a moving branch during conformance. JavaScript runners can point
the bounded loader at a vendored copy without changing the fixture:

```js
import { loadSemanticQueryCorpus } from "./loader.mjs";

const corpus = await loadSemanticQueryCorpus({
  schemaUrl: new URL("./vendor/semantic-query/v1/schema.json", import.meta.url),
  corpusUrl: new URL("./vendor/semantic-query/v1/corpus.json", import.meta.url),
});
```

The corpus is a conformance source artifact rather than a runtime SDK API. This
keeps application bundles free of the validator while still giving server and
future SDK runners the same portable JSON contract.

## Cross-field invariants

Every runner must enforce the invariants that JSON Schema cannot express:

- field and case IDs are unique; key, geometry, temporal, query, sort, group,
  and metric references resolve to declared fields;
- every source row has exactly the declared fields and respects logical type
  and nullability;
- metric aliases neither collide with fields nor repeat;
- every case has one projection for every declared protocol and the corpus
  contains the complete required coverage taxonomy;
- the frozen clock parses deterministically and the full fixture contains no
  credential-bearing key or value.

## Coverage and interpretation

Version 1 covers comparison, null, list/range, pattern, spatial, temporal,
projection, sorting, pagination, grouping, and statistics. Adversarial cases
also pin injection quoting, Unicode, CRS definition-axis versus payload-axis
order, inclusive boundaries, a frozen clock, and explicit envelope
approximation.

An `exact` projection means the compiler accepted every query node without a
loss. `approximate` requires the exact stable loss code, path, and reason.
`unsupported` requires the exact stable diagnostic code, path, and reason.
Unsupported is a successful conformance result when the fixture declares it;
weakening or dropping the operation is not.

The reference evaluator establishes the normalized logical result. It does not
pretend to be a production database. Protocol integration runners may execute
the emitted artifact against the same rows, but they must normalize the result
to the one expected row set in the corpus.

## Changing the corpus

Add a case to version 1 only when its meaning is backward compatible with the
existing schema and outcome taxonomy. Keep case IDs stable and append new
cases; do not rewrite an accepted case to mean something else. Any incompatible
schema, query, result, or fidelity change creates a new version directory and
documents migration from the previous version.

Before review, run:

```bash
npm test -- test/query-planner-semantic-corpus.test.ts
npm run typecheck
npm run check
```

Fixtures must remain deterministic, bounded, and free of endpoint locators,
authorization values, credentials, live cursors, or production data.
