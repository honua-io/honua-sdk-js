---
type: guide
description: "Discover live Sources through native gRPC-Web descriptors."
title: "Native gRPC metadata and discovery"
---

# Native gRPC metadata and discovery

Use gRPC-Web for live Honua layers and cloud-native files for immutable datasets.
Native discovery requires the additive `DescribeService` and `DescribeLayer`
contract introduced in geospatial-grpc 1.1.0. Browser clients use unary RPCs for
metadata. They never fetch GeoServices REST metadata or query a sample feature to
infer a layer schema. A server without descriptor RPCs reports an error; update
the server before converting discovery.

```ts doc-test=compile
import { connect } from "@honua/sdk-js";
import { HonuaClient } from "@honua/sdk-js/grpc-web";

const endpoint = "https://maps.example.test";
const connection = await connect({
  endpoint,
  protocol: "grpc",
  client: new HonuaClient({ baseUrl: endpoint }),
  serviceId: "parcels",
  layerId: 0, // Omit to discover every layer accessible to this caller.
  authorizationScopeFingerprint: "tenant-a:editor",
});

const parcels = connection.dataset.source("0");
const descriptor = await parcels?.protocol("grpc")?.describe();
const templates = descriptor?.layer?.templates;
const relationships = descriptor?.layer?.relationships;
```

The endpoint is the gRPC-Web transport base URL. Service and layer identities are
explicit; a GeoServices-shaped URL is unnecessary. `connect` selects gRPC-Web by
default for this protocol; browser applications inject the explicit `/grpc-web`
client shown above and install the three runtime peers listed in
[native data paths](native-data-paths.md#browser-runtime-dependencies). Supplied
clients must also use gRPC-Web. The authorization scope
fingerprint must distinguish callers whose visible layers, fields or capabilities
differ. Existing canonical FeatureServer URLs remain accepted as identity input.

`DescribeService` follows bounded, opaque page tokens and obtains each authorized
layer with `DescribeLayer`. Discovery rejects duplicate identities, mismatched
services or layers, token loops and empty pages with continuation tokens.
Cancellation propagates to each RPC. No feature queries run during discovery.

A caller capability descriptor determines query, streaming and editing access.
Missing capability metadata remains unknown; false flags grant no capability.
The vendor-neutral source schema contains typed fields, nullability, editability,
defaults, coded or range domains, key and temporal roles, and geometry dimensions.
64-bit integers use exact decimal strings in the JSON schema. Timestamp defaults
and domain bounds use UTC ISO strings; numeric defaults follow the declared field type. Explicit null defaults remain distinct from absent defaults. Axis and
coordinate order remain unknown unless the contract supplies them.

Use the typed native handle for complete metadata: subtypes, templates,
relationships, time information and editing information. `describe()` returns the
protobuf response and preserves `bigint` values; convert them explicitly before
serializing to JSON. The native handle exposes no REST metadata method.

For direct calls, import `HonuaClient` from `@honua/sdk-js/grpc-web`, then call
`describeService({ serviceId, pageSize, pageToken, signal })` or
`describeLayer({ serviceId, layerId, signal })`. Direct service calls return one
page; continue with `nextPageToken` until it is empty. Both methods use the
client's existing authentication, timeout and retry configuration.
