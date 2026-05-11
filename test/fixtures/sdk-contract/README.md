# SDK Contract Fixtures

These JSON fixtures define cross-SDK semantics for the Honua shared source and
query contract. They are meant to be consumed by JavaScript, Python, and .NET
tests.

The fixtures validate behavior and envelopes, not exact method spelling. Each
SDK should map the same concepts into idiomatic local names.

Current fixture:

- `semantic-contract.v1.json`: protocol and capability registries, common
  language binding names, result-envelope scenarios, unsupported-capability
  expectations, and degraded-result expectations.
- `query-tile-server.v1.json`: dynamic query tile server routes, request
  parameters, TileJSON metadata, feature detail response, cache validators, and
  degradation/error envelopes.

When this fixture changes, update:

- `docs/sdk-surface-alignment.md`
- `docs/shared-client-contract.md`
- Python and .NET consumers once those tickets land
