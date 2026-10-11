# gRPC candidate query regression evidence

On 2026-10-11, the source-built SDK passed all 13 tests in
`test/integration/surfaces/grpc.integration.ts` against the isolated candidate
server, with zero skips. The five live checks exercised query round-trip and
canonical object IDs, REST/gRPC attribute parity, streams beyond 2000 rows,
authentication attachment, and retry. The other eight checks validate int64 IDs.

The source build is `9a28ecafa688c106860927e5d995f59cab75a1e6`; the working HEAD
was `7b6ad4daaadb7b35a8e1fbf202e404f9fc66668d`, whose two followups only refresh
the API report and offline shell manifest. This is source SDK evidence, not
certification of the currently published `@honua/sdk-js@0.1.14` artifact.

The server came from honua-release manifest snapshot
`e0a5bb8a8d20f82c87ad00872181f2a5b6163b2e`:

- Source: `93cad86ec4fb28fba3ff0b9358059d86aa55dde5`.
- Image: `ghcr.io/honua-io/honua-server@sha256:785de2ae7f72e6277ce62aa1ece4f08ee0425970b71c47f9f4843c0baae2c8db`.
- Candidate cut: `2026-10-11T02:00:00Z`.

A unique Docker network, PostGIS, Redis, and server were created for this run.
The server migrated an empty database before the unmodified `places-roads-v1`
seed was applied. An additional 2500 rows cloned the first layer-0 feature,
changing only each clone's name, while retaining every original row and ID.
The fixture defines ten original layer-0 rows, giving 2510 rows by construction;
the live test independently requires the REST count to exceed 2000, but its exact
count was not printed in the saved output.
The stream parity test requires more than 2000 rows and therefore executed its
real REST and gRPC comparison rather than taking its fixture-size skip.

The runner verified the exact image and its source-revision label. It bounded
readiness with curl and refreshed the ephemeral published port after restarting
the server. The test client uses its configured request timeout. Each created
container and network was removed after the successful run; other stacks were
untouched. Credentials were generated per run and redacted from saved output.

The original local invocation is recorded below for provenance. Its temporary
path and the frozen runner's worktree path are not portable setup instructions.
The runner must be adapted to a fresh checkout and the shared lock available
on that host before reuse.

The exact invocation was:

```sh
/tmp/honua-sdk-with-build-lock node /tmp/honua-sdk1952.mjs
```

The runner then invoked:

```sh
npm run test:integration -- test/integration/surfaces/grpc.integration.ts
```

Frozen evidence: [runner](grpc-candidate-20261011/runner.mjs),
[diagnostic](grpc-candidate-20261011/diagnostic.json),
[test output](grpc-candidate-20261011/integration.log), and
[integration metadata](grpc-candidate-20261011/integration-meta.json).
The runner records the original local paths; these copies preserve the actual
run rather than claim a new installed-client release receipt.

The published SDK still predates the count/IDs and gRPC ID fixes. Issue #1894
therefore still needs publication, a reviewed release repin, and installed-client
matrix activation. This run does not exercise #2003: no installer-minted key was
created, and an administrative fixture credential cannot prove those grants.
