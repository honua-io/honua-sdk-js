# Source schema v2 migration

Source schema v2 is an experimental, vendor-neutral discovery projection. It
is available from the focused `@honua/sdk-js/source-schema` subpath and can
enrich GeoServices, OData 4.0, GeoParquet, WMS 1.3.0, and WMTS 1.0.0 discovery.
The legacy schema and the default lightweight `connect()` path remain unchanged
during this rollout.

Opt in without issuing a second metadata request:

```ts doc-test=skip reason="requires a live endpoint and auth scope"
import { connectWithSourceSchemaV2 } from "@honua/sdk-js/source-schema";

const connection = await connectWithSourceSchemaV2({
  endpoint,
  protocol: "odata",
  authorizationScopeFingerprint: "anonymous",
});
```

The focused connection uses a distinct cache identity and validates cached v2
fingerprints before use. Plain root `connect()` neither emits nor trusts an
injected `schemaV2`; this keeps the schema runtime and pinned PROJJSON validator
out of root, `/honua`, browser, query-planner, and ordinary `/contract` bundles.
Its focused return type exposes the complete validated schema. Generic
`SourceDescriptor` and discovery-cache types expose only the lightweight
`kind`, `version`, and `fingerprint` transport envelope; pass such a value to
`parseSourceSchemaV2` before inspecting schema semantics.

## Compatibility window

Existing code can continue to read `source.descriptor.schema`:

```ts doc-test=skip reason="illustrates the legacy compatibility surface"
const legacy = source.descriptor.schema;
const objectId = legacy?.primaryKey;
const esriType = legacy?.fields?.[0]?.type;
```

That object still contains `HonuaFieldInfo` values and Esri field-type strings.
It is not used as the source of truth for new semantic identity. New code can
opt into the parallel projection:

```ts doc-test=skip reason="schema v2 is populated by discovery at runtime"
const schema = source.descriptor.schemaV2;
if (schema) {
  const idFields = schema.fields.filter((field) => field.roles.includes("feature-id"));
  const geometryFields = schema.fields.filter((field) => field.roles.includes("geometry"));
  console.log(schema.version, schema.fingerprint, idFields, geometryFields);
}
```

Do not translate `LogicalType` values back into Esri strings. Applications that
need raw GeoServices metadata should use the existing `HonuaClient` metadata
methods or a protocol-native handle. A logical `unknown` value is intentional:
its bounded `native` reference records what was observed without pretending it
was a string, point, or another portable type.

## Field mapping

| Legacy access | Schema v2 access |
| --- | --- |
| `field.type === "esriFieldTypeOID"` | `field.roles` contains `primary-key` or `feature-id` |
| `field.type === "esriFieldTypeGeometry"` | `field.roles` contains `geometry`; inspect `schema.geometry` for kind, layout, CRS, and primary-field state |
| `schema.primaryKey` | `schema.key` (`known`, `none`, or evidence-bearing `unknown`) |
| `schema.timeField` | `schema.temporal` and the `time-*` field roles |
| `field.length` | `field.type.kind === "string" && field.type.maxLength` |
| absent/unknown native type coerced to string | `field.type.kind === "unknown"` with a bounded native reference |

Every v2 field explicitly distinguishes nullability, mutability, value-domain,
and constraint knowledge. `none` means metadata affirmatively reported an
unconstrained field or the concept cannot apply to that logical type;
`unknown` means metadata was absent, not inspected in this migration slice,
invalid, conflicting, unrecognized, or over the safety bound. In particular,
missing GeoServices `domain`, unparsed OData validation annotations, and
uninspected GeoParquet/Arrow constraints are `unknown/not-reported`, not
invented declarations of no constraint. An explicit GeoServices `domain: null`
remains `none/unconstrained`.

A `known` key is executable identity, not a name hint: every member must be a
non-nullable scalar whose JSON encoding can produce `FeatureIdentityValue`.
OData key properties therefore become non-nullable when the CSDL `Nullable`
facet is omitted; an explicit nullable contradiction fails projection.
GeoServices infers a key only from one unique OID field. Multiple OID
candidates, a missing declared `objectIdField`, or a declaration that targets a
non-OID field becomes `unknown/conflicting` and carries no primary-key role.

Scalar date and timestamp types do not by themselves establish a dataset time
dimension. In this rollout only explicit GeoServices `timeInfo` assigns
`time-*` roles or a non-`none` `schema.temporal`; ordinary OData and GeoParquet
date columns remain ordinary fields. OData non-flags enums are logical strings
whose coded values are member names, matching their JSON wire form. Their
underlying numeric declarations remain bounded native evidence rather than
portable values. Mixed implicit/explicit declarations are evaluated in CSDL
document order (first omitted value `0`, later omitted value previous-plus-one)
and fail closed on overflow, invalid names, or an empty declaration.
`duration` remains a supported scalar amount but cannot be used as a temporal
instant or interval endpoint. A range whose endpoints are equal is valid only
when both endpoints are inclusive; either exclusive endpoint would describe an
empty domain and is rejected.

OData metadata parsed by the SDK records projection-safety evidence without
changing its legacy string-keyed shape. The focused projector rejects a
selected entity shape when namespace-local type names are ambiguous or when
the entity or a referenced complex type uses unresolved `BaseType`
inheritance. It never labels a partial inherited shape `openContent: "closed"`.

CRS values distinguish definition-axis order from payload coordinate order.
OData's omitted SRID defaults are represented explicitly: Geography uses
EPSG:4326, while Geometry uses the protocol's SRID 0 / unspecified Cartesian
binding without fabricating EPSG:0. GeoParquet PROJJSON is checked against a
pinned, generated validator for the official v0.7 CRS schema. Invalid CRS
metadata degrades that binding to `unknown` without discarding the field or
geometry inventory.
GeoServices WKT is retained only when it has a recognized WKT1/WKT2 CRS root,
a quoted name, and balanced, fully closed delimiters. It is marked
`validation: "unverified"` and is not an executable CRS until an engine-backed
validator promotes it; arbitrary strings remain bounded native evidence under
an `unknown/unrecognized` definition. Reprojected bindings also require their
public definition to match the normalized reprojection target.

Non-null geometry defaults use exact canonical RFC 7946 shapes. All positions
must have one ordinate arity, polygon rings must close, and the value's root
type and arity must agree with declared geometry-type and layout knowledge.

GeoParquet 1.0 references PROJJSON v0.5, while this public normalized contract
intentionally pins v0.7. A valid 1.0 CRS carrying the v0.5 schema identifier is
therefore retained as bounded native evidence and exposed as an `unknown` CRS
definition unless it can be promoted safely. Its WKB payload order remains
known x/y; inability to promote CRS semantics does not erase encoding facts.

## Identity, caches, and plans

`schema.fingerprint` is SHA-256 over the accepted semantic projection from the
source-contract v2 decision. Presentation text, observation timestamps, and raw
native definitions do not change it; logical type, roles, domains,
constraints, key, geometry/CRS, temporal semantics, and extensions do.

The connection discovery snapshot remains v4. The focused projector adds its
own cache-identity suffix, stores `schemaV2` only under that distinct identity,
and revalidates the full v2 fingerprint on every cache read. Default
`connect()` cache identities and snapshots are unchanged.

Generic query-planner entry points do not consume `descriptor.schemaV2` yet.
They cannot distinguish a focused, validated value from an arbitrary object on
a caller-constructed `SourceDescriptor` without importing the full validator.
Until descriptor-native plan identity lands, use the focused validating bridge
to feed the verified fingerprint through the existing planner context:

```ts doc-test=skip reason="requires a live focused connection and executable source"
import { executeQueryPlan, explainQuery } from "@honua/sdk-js/query-planner";
import { sourceSchemaV2QueryContext } from "@honua/sdk-js/source-schema";

const source = connection.source();
const schemaContext = sourceSchemaV2QueryContext(source.descriptor);
const plan = explainQuery({ descriptor: source.descriptor, query, ...schemaContext });
await executeQueryPlan(plan, source, schemaContext);
```

The helper reparses the full schema, so a forged or drifted fingerprint fails
before it can become cache identity. A changed validated schema changes plan
identity and old-plan execution fails with `plan-context-mismatch`. Full
descriptor, capability, and schema plan identity remains owned by the planned
descriptor-identity work rather than trusting generic transport envelopes.

Use `serializeSourceSchemaV2`, `parseSourceSchemaV2`, and
`cloneSourceSchemaV2` for JSON-safe boundaries. They validate the discriminator,
version, canonical fingerprint, bounds, and nested values, and return a deeply
frozen schema. `cloneSourceSchemaV2` performs the same full reparse and returns
a fully validated clone. Do not persist a plain object after manually changing
its fingerprint.

JSON parsing, `structuredClone`, worker transfer, and another installed copy of
the SDK preserve the structural `SourceSchemaV2` value but do not by themselves
recompute its semantic fingerprint. Re-enter the focused runtime with
`parseSourceSchemaV2` whenever such a value becomes authoritative (for example,
at an application cache or worker ingestion boundary). The focused connection
path does this on every discovery-cache hit. Lightweight generic discovery
checks only the `kind`, `version`, and fingerprint syntax needed to transport
the optional envelope. It does not maintain a hidden process-local trust
registry or claim to perform full schema validation; generic query planning
ignores the envelope entirely.

Bounded native definitions are diagnostic evidence, not a credential store.
Serialization recursively redacts credential fields, URL user-info, signed
query parameters, bearer/basic credentials, private keys, and high-confidence
token literals while preserving ordinary protocol metadata and environment
placeholders.

## Rollout boundary

The opt-in GeoServices, OData 4.0, GeoParquet, WMS, and WMTS discovery
projection populates `schemaV2`. WMS intentionally projects no fields and
unknown feature geometry because Capabilities has no portable FeatureInfo
schema; WMTS projects an observed zero-field, no-geometry closed schema. Other
protocols and default root `connect()` continue to expose their existing
discovery shape until their scheduled migration issues land. Missing `schemaV2`
means “not projected”; it must not be replaced with an empty schema or a
fabricated fingerprint.

On the opt-in path, missing `schemaV2` is reserved for a protocol that did not
advertise a field inventory. Invalid advertised metadata or an internal
normalization failure rejects `connectWithSourceSchemaV2()` instead of being
silently converted to absence. Default `connect()` remains independent of this
experimental projection.
