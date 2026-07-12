# Sanitized diagnostic bundles (`honua doctor`)

`honua doctor` creates a local, bounded support artifact without uploading it. The command uses the canonical
[`diagnostic-bundle.v1` JSON Schema](https://honua.io/schemas/diagnostic-bundle.v1.json), vendored byte-for-byte in
`schemas/diagnostic-bundle.v1.json` and pinned to:

- support source commit `0c990fbe8f519a00a57e26dab21cbb8f80d559ea`;
- 6,494 bytes; and
- SHA-256 `4dd7282d17bb417d56f1c3cfa243e03b612a401e5d22be766658849287e431a9`.

The public provenance record is at
[`diagnostic-bundle.v1.provenance.json`](https://honua.io/schemas/diagnostic-bundle.v1.provenance.json).

## Capture and review

Capture one failing exchange in a local JSON file. This input may contain raw values because it is read only into
memory and is never copied to output:

```json
{
  "request": {
    "method": "GET",
    "url": "https://server.example/api/v1/services/parcels?token=secret",
    "headers": { "authorization": "Bearer secret", "x-request-id": "request-1" }
  },
  "response": {
    "status": 500,
    "mediaType": "application/json",
    "headers": { "content-type": "application/json" },
    "body": { "error": "failed", "apiKey": "secret" }
  }
}
```

Then explicitly choose classification and both consent values:

```bash
honua doctor \
  --exchange ./failure.json \
  --classification customer-data \
  --redaction-acknowledged=true \
  --share-with-support=false \
  --output ./diagnostic-bundle.json \
  --json
```

Add `--base-url https://server.example/honua` to attempt an anonymous, credential-free capability probe. The
configured base path is preserved (`/honua/api/v1/services`). Probe failure becomes a sanitized envelope and never
removes the explicitly supplied failure, which stays last in the bundle.

Review `diagnostic-bundle.json`, then rerun with `--share-with-support=true` only when you intend to submit it through
the support intake. The CLI never uploads. Output is written with owner-only permissions where the platform supports
them. `--json` prints only a machine summary and `outputWritten` state, not the path or captured body previews.

## Privacy boundary

The emitter:

- drops Authorization, Proxy-Authorization, Cookie, Set-Cookie, API keys, signatures, tokens, and every
  non-allowlisted header;
- removes URL origin/userinfo, drops sensitive query parameters, placeholders all query values, and preserves only a
  small allowlist of public route vocabulary (unknown path segments become `{value}`);
- recursively redacts sensitive JSON keys, form values, free-text credentials, common provider tokens, AWS keys,
  email addresses, and up to two URL-encoding layers;
- hashes the original in-memory bytes, but persists only a redacted preview capped at 8 KiB, original byte count,
  SHA-256, and truncation/redaction flags; and
- refuses bodies above the schema's 25 MiB ceiling or bundles above 50 envelopes.

No raw body, credential, cookie, customer payload, or configured API key is written to stdout, stderr, the artifact,
telemetry, or snapshots.

## Read-only replay

Replay one sanitized exchange against a separately configured server:

```bash
honua doctor \
  --replay ./diagnostic-bundle.json \
  --base-url https://server.example \
  --output ./diagnostic-replay.json \
  --timeout-ms 10000 \
  --json
```

Replay validates the entire input before network access, verifies the schema pin and verifiable body hashes, sends no
captured headers or query values, omits credentials, disables redirects and caching, and permits only one bounded
`GET` or `HEAD`. It refuses mutations, subscriptions/streams, job submission, uploads, traversal, placeholder path
segments, non-HTTPS remote origins, unsafe headers, credential-bearing artifacts, hash drift, malformed schemas,
over-budget responses, timeout, and abort. The result is a new sanitized bundle; replay never modifies its input.

Programmatic APIs are available from `@honua/sdk-js/diagnostics`.
