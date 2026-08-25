# Studio lifecycle contract fixtures

These fixtures document the `honua-server` Studio package lifecycle API
(`/api/v1/studio`, `docs/internal/admin-api/studio-package-lifecycle.md`) that
`HonuaStudioLifecycleClient` (`src/studio/lifecycle-client.ts`) consumes.

Request/response fixtures (`*.v1.json`) follow the same shape as
`test/fixtures/control-plane`: `{ schemaVersion, request: { method, path,
body? }, response: { status, body } }`. Every success `body` is the raw
`ApiResponse<T>` envelope (`{ success, data, timestamp }`) the server sends —
`HonuaStudioLifecycleClient` unwraps `.data` itself. Every non-2xx `body` is
an RFC 7807 problem document with `type:
"https://honua.io/problems/studio"`.

- `package-families.v1.json` — `GET /package-families` capability discovery.
- `draft-create.v1.json` — `POST /package-drafts` for the `query` family (the
  envelope shape is copied verbatim from the API doc's "Package Envelope"
  example).
- `draft-get.v1.json` — `GET /package-drafts/{draftId}`.
- `draft-replace.v1.json` — `PUT /package-drafts/{draftId}` with a
  `generation` bump.
- `draft-replace-generation-conflict.v1.json` — the same route returning `409`
  with an RFC 7807 body; exercises
  `isHonuaStudioGenerationConflict`.
- `draft-delete.v1.json` — `DELETE /package-drafts/{draftId}`, the
  no-payload `ApiResponse<object>` shape.
- `draft-validate.v1.json` — `POST /package-drafts/{draftId}/validate`.
- `draft-preview-plan-sync.v1.json` /
  `draft-preview-plan-job.v1.json` — `POST
  /package-drafts/{draftId}/preview-plan` for a synchronous family (`query`)
  and a job-backed one (`gp`).
- `content-version-create.v1.json` — `POST
  /package-drafts/{draftId}/content-versions`.
- `content-version-list.v1.json` — `GET /content-items/{itemId}/versions`.
- `content-version-get.v1.json` — `GET
  /content-items/{itemId}/versions/{versionId}`.
- `content-version-not-found.v1.json` — the same route returning `404`.
- `version-comparison.v1.json` — `POST
  /content-items/{itemId}/version-comparisons`.
- `publish-request-legacy-accepted.v1.json` /
  `publish-request-legacy-rejected.v1.json` — `POST
  .../publish-requests` under the **legacy synchronous** behaviour, for a
  `valid` version (published pointer moves, `status: "accepted"`) and an
  `invalid` one (`status: "rejected"`, pointer unchanged). These keep the
  lower-case legacy status values on purpose; `normalizeStudioPublicationStatus`
  maps them onto the canonical walk.
- `publish-request-<state>.v1.json` — `GET
  .../publish-requests/{requestId}`, one per canonical publication-proposal
  state: `awaiting-approval`, `approved`, `executing`, `active`, `rejected`,
  `failed`. Every one carries the five joined identifiers
  (`operationInstanceId`, `proposalId`, `proposalUri`, `auditId`,
  `correlationId`) plus the `contentHash` pin. Only `active` legitimately
  carries `publicationUrl`.
- `publish-request-failed.v1.json` and
  `publish-request-unknown-status.v1.json` deliberately carry a
  `publicationUrl` they have no right to — a hostile/misbehaving server —
  so the tests can prove the client refuses to surface a final URL from any
  state other than `Active`. `publish-request-unknown-status.v1.json` also
  pins the "unknown status is neither terminal nor successful" rule.
- `publish-request-idempotent-replay.v1.json` — a replayed `POST
  .../publish-requests` carrying the same `idempotencyKey`, answered `200`
  (not `201`) with byte-identical joined identifiers.
- `publish-request-get-not-found.v1.json` /
  `publish-request-forbidden.v1.json` — `404` and `403` (owner/tenant scope)
  problem documents for the proposal read.
- `publish-request-self-approval-forbidden.v1.json` — the server refusing a
  proposer's attempt to approve their own publication with `403`. The SDK
  exposes no approve method at all, so this route is only reachable through
  the generic `raw()` escape hatch; the fixture pins that approval stays a
  separate principal on the server side too.
- `reopen.v1.json` — `POST .../versions/{versionId}/reopen`.
- `rollback-request.v1.json` — `POST
  /content-items/{itemId}/rollback-requests`.
- `internal-error.v1.json` — a `500` RFC 7807 body.

## Content-item and draft enumeration (`honua-server#3003`)

`GET /content-items` and `GET /package-drafts` share one filter/pagination
contract: `family` (comma-separated), `workspaceId`, `owner`, `q` (a
case-insensitive substring match on `packageKey`), plus `cursor`/`limit`
opaque keyset pagination ordered by `updatedAt` then row id descending;
`GET /content-items` additionally accepts `state`
(`draft`/`current`/`published`). Both answer with `{ items, total, nextCursor }`
where `total` counts every matching row across all pages and `nextCursor` is
`null` (and therefore omitted by the source-generated JSON context) on the last
page. These fixtures add a `request.query` member the request/response
fixtures above do not need.

Every `cursor` value below is produced with the server's own codec
(`StudioListCursor`: `base64(utf8("<updatedAt.UtcTicks>:<id>"))`), so replaying
one is a faithful round trip rather than an opaque placeholder string.

- `content-item-list-page-1.v1.json` / `content-item-list-page-2.v1.json` —
  the doc's `?family=map&state=published&limit=2` example walked to
  completion. Page 1's two rows carry a joined publication badge; the second
  row is `published` in Studio while its *route* is `suspended`, which is why
  the badge lifecycle is a separate vocabulary from the item state. Page 2's
  row omits `publication` entirely (the registry join found nothing) and ends
  the walk with `nextCursor: null`.
- `content-item-list-empty.v1.json` — a zero-row page: `total: 0` and no
  `nextCursor` member at all, pinning that "absent" reads as exhausted.
- `content-item-list-owner-scoped.v1.json` — a non-admin caller under
  `Studio:EndUserAuthorization:Enabled` asked for another principal's content;
  the server force-scoped the effective `owner` filter to the caller and
  answered with the caller's own rows. The client must report the `ownerId`
  the server sent, never the one it asked for.
- `content-item-list-forbidden.v1.json` — `403` with
  `code: "studio_authorization/authentication_required"`, the denial for a
  caller whose id cannot be resolved for a scoped listing. The server refuses
  rather than falling through to an unscoped list.
- `content-item-list-invalid-state.v1.json` /
  `draft-list-invalid-family.v1.json` — `400` for an unknown `state` / `family`
  filter value, in the server's `"<filter> filter is invalid: unknown value
  '<raw>'"` wording.
- `content-item-list-stalled-cursor.v1.json` — a misbehaving server handing
  back the very cursor it was queried with. The bounded walk refuses to page
  forever on it.
- `draft-list-page-1.v1.json` / `draft-list-page-2.v1.json` — the draft walk.
  Rows are full `StudioPackageDraft` objects, identical to
  `GET /package-drafts/{draftId}`, and carry no publication badge: drafts are
  mutable and pre-publication by definition.
- `draft-list-not-deployed.v1.json` — a `404` with **no body**, which is what a
  deployment predating `honua-server#3003` returns for a route it does not map.
  The client classifies it `not-found` from the status alone; reporting "no
  drafts" for a missing endpoint would be a silent lie.

`envelopes/*.json` are standalone `StudioPackageEnvelope` documents (not
request/response wrappers), one per package family, used for the lossless
serialize/parse round-trip test. `map.v1.json` and `app.v1.json` bodies are
shaped like the existing `honua_map_package.v1` / `honua_app_package.v1`
models per the API doc; the remaining families currently receive only
envelope-level validation, so their `body` fields are representative but not
family-schema-pinned.
