# Draft catalog fixtures

Synthetic contract and response fixtures supplied by s-front-door for the
approved rc.2 mock-first slice. They are not generated production contracts,
server authorization proof or a live integration. The public anonymous ceiling
and permitted facets are server-owned. The fixture adapter is test-only and
contains no credentials or production fallback. Replace these bytes with the
approved generated schema fixtures at canonical contract cutover.

The browser host intentionally omits remote fixture thumbnails so its actual
strict self-only CSP can be tested without contacting a synthetic domain. DOM
tests cover supplied alt text, URL validation and fallback rendering separately.
JSON-LD crosswalk projections have not been supplied; none are synthesized here.
