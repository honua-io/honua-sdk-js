# Preview alerts fixture evidence

This directory retains the bounded SDK #1954 integration evidence. It covers
unpersisted alert draft validation on a dedicated single-tenant Pro fixture,
with `alerts.geofence` explicitly off and on. It does not qualify alert workers,
delivery, multi-tenant deployments, Community alerts, GA support, or a full release.

Run [38314349221](https://github.com/honua-io/honua-sdk-js/actions/runs/38314349221)
executed SDK source `6c2052a5182c2d691392544198fa6294706d1804` against the actual
repository-variable image `d7a45c87…` / server `e3ab87ce…`. The enabled case passed;
the disabled case **failed**, receiving HTTP 200 instead of 404. Both original
Vitest reports and the original metadata are retained byte-for-byte and hashed
in `receipt.json`. The metadata is the workflow's final conformance metadata;
the two separate raw reports identify the alerts phases. HTTP statuses are also
visible in that run's masked server logs.

The historical server's [registry](https://github.com/honua-io/honua-server/blob/e3ab87cebb7bf2d32c4e8cdb145f8d626b864d8e/src/Honua.Core/Features/Capabilities/CapabilityRegistry.cs#L297)
marks alerts as `Implemented`. Its [resolver](https://github.com/honua-io/honua-server/blob/e3ab87cebb7bf2d32c4e8cdb145f8d626b864d8e/src/Honua.Core/Features/Capabilities/CapabilityGateResolver.cs#L55)
checks the experimental flag only for `Experimental`, explaining the failed
negative control. The dotted configuration key was valid; the assertion was
not weakened.

The self-contained workflow now selects the existing reviewed repository pin,
`3ef3bd41…` / `ff5f5671…` / cut `2026-10-04T08:09:54Z`, directly for both fixtures.
[SDK PR #1956](https://github.com/honua-io/honua-sdk-js/pull/1956) introduced that
identity and compatible seed. Successful [server run 37188030565](https://github.com/honua-io/honua-server/actions/runs/37188030565)
built that exact source; its [AOT publisher](https://github.com/honua-io/honua-server/actions/runs/37188030565/job/111404621228)
records the image revision and attestation subject digest. That source explicitly
[gates the alerts routes](https://github.com/honua-io/honua-server/blob/ff5f5671903e96e13cffac7b73546c3ed0f853c5/src/Honua.Server/Program.cs#L1690).
The reviewed-candidate replay is pending; the historical failed run is not a pass.
