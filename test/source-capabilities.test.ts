import { describe, expect, it } from "vitest";

import {
  CAPABILITY_PROFILE_KIND,
  CAPABILITY_PROFILE_VERSION,
  type CapabilityEvaluationEntry,
  evaluateCapabilityProfile,
  serializeCapabilityProfile,
} from "../src/source-capabilities.js";

const SCHEMA_FINGERPRINT = `sha256:${"a".repeat(64)}` as const;

function evidenceEntry(
  id: CapabilityEvaluationEntry["id"],
  claimed: CapabilityEvaluationEntry["claimed"] = "supported",
  observed: CapabilityEvaluationEntry["observed"] = "supported",
  overrides: Partial<CapabilityEvaluationEntry> = {},
): CapabilityEvaluationEntry {
  const evidence: CapabilityEvaluationEntry["evidence"] = [
    {
      kind: "protocol-default",
      truth: claimed,
      reference: `adapter:${id}`,
      sourceFingerprint: SCHEMA_FINGERPRINT,
    },
    ...(observed === "not-observed"
      ? []
      : [
          {
            kind: "metadata" as const,
            truth: observed,
            reference: `metadata:${id}`,
            observedAt: "2026-07-13T12:00:00Z",
            sourceFingerprint: SCHEMA_FINGERPRINT,
          },
        ]),
  ];
  return { id, claimed, observed, evidence, ...overrides };
}

describe("source capability profile", () => {
  it.each([
    {
      label: "supports matching claim and observation",
      entry: evidenceEntry("query"),
      effective: "supported",
      reasons: ["supported-by-claim-and-observation"],
    },
    {
      label: "honors an unsupported adapter claim",
      entry: evidenceEntry("query", "unsupported", "supported"),
      effective: "unsupported",
      reasons: ["unsupported-by-claim"],
    },
    {
      label: "lets metadata downgrade a supported default",
      entry: evidenceEntry("query", "supported", "unsupported"),
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    },
    {
      label: "does not upgrade an unknown claim from metadata",
      entry: evidenceEntry("query", "unknown", "supported"),
      effective: "unknown",
      reasons: ["claim-unknown"],
    },
    {
      label: "keeps failed optional discovery unknown",
      entry: evidenceEntry("query", "supported", "unknown"),
      effective: "unknown",
      reasons: ["observation-unknown"],
    },
    {
      label: "keeps unrequested discovery explicit",
      entry: evidenceEntry("query", "supported", "not-observed"),
      effective: "unknown",
      reasons: ["observation-not-observed"],
    },
  ] as const)("$label", ({ entry, effective, reasons }) => {
    const profile = evaluateCapabilityProfile([entry]);

    expect(profile.entries[0]).toMatchObject({ effective, reasons });
  });

  it("intersects policy, environment, peer, and authorization without mutating cached evidence", () => {
    const cachedEvidence = [
      evidenceEntry("query", "supported", "supported", {
        requirements: { environments: ["worker"], peers: ["@duckdb/duckdb-wasm"] },
        authorizationScopes: ["dataset:parcels:read"],
      }),
    ] as const;

    const policyDisabled = evaluateCapabilityProfile(cachedEvidence, {
      policy: { deny: ["query"] },
      environment: "worker",
      availablePeers: ["@duckdb/duckdb-wasm"],
      authorization: { grantedScopes: ["dataset:parcels:read"] },
    });
    const unavailable = evaluateCapabilityProfile(cachedEvidence, { environment: "browser" });
    const authorizationRequired = evaluateCapabilityProfile(cachedEvidence, {
      environment: "worker",
      availablePeers: ["@duckdb/duckdb-wasm"],
    });
    const authorizationDenied = evaluateCapabilityProfile(cachedEvidence, {
      environment: "worker",
      availablePeers: ["@duckdb/duckdb-wasm"],
      authorization: { deniedScopes: ["dataset:parcels:read"] },
    });
    const supported = evaluateCapabilityProfile(cachedEvidence, {
      environment: "worker",
      availablePeers: ["@duckdb/duckdb-wasm"],
      authorization: { grantedScopes: ["dataset:parcels:read"] },
    });

    expect(policyDisabled.entries[0]).toMatchObject({
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(unavailable.entries[0]).toMatchObject({
      effective: "peer-unavailable",
      reasons: ["environment-unavailable:browser", "peer-unavailable:@duckdb/duckdb-wasm"],
    });
    expect(authorizationRequired.entries[0]).toMatchObject({
      effective: "authorization-required",
      reasons: ["authorization-required:dataset:parcels:read"],
    });
    expect(authorizationDenied.entries[0]).toMatchObject({
      effective: "authorization-denied",
      reasons: ["authorization-denied:dataset:parcels:read"],
    });
    expect(supported.entries[0]?.effective).toBe("supported");
    expect(policyDisabled.fingerprint).not.toBe(supported.fingerprint);
    expect("effective" in cachedEvidence[0]).toBe(false);
  });

  it("normalizes JSON-safe collections and serializes deterministically", () => {
    const entries = [
      evidenceEntry("com.example.export", "supported", "supported", {
        constraints: {
          outputFormats: ["text/csv", "application/geo+json"],
          filterOperators: ["intersects", "eq"],
          spatialPredicates: ["within-distance", "intersects"],
          pagination: { modes: ["next-link", "offset"], maxPageSize: 1_000 },
          limits: { maxResponseBytes: 8_192, maxRecords: 100 },
          extensions: { "com.example.cost": { units: "credits", value: 2 } },
        },
      }),
      evidenceEntry("query"),
    ];

    const first = evaluateCapabilityProfile(entries);
    const second = evaluateCapabilityProfile([...entries].reverse());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: CAPABILITY_PROFILE_KIND,
      version: CAPABILITY_PROFILE_VERSION,
      entries: [
        {
          id: "com.example.export",
          constraints: {
            outputFormats: ["application/geo+json", "text/csv"],
            filterOperators: ["eq", "intersects"],
            spatialPredicates: ["intersects", "within-distance"],
            pagination: { modes: ["next-link", "offset"] },
          },
        },
        { id: "query" },
      ],
    });
    expect(JSON.parse(serializeCapabilityProfile(first))).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.constraints?.extensions)).toBe(true);
    expect(() => (first.entries as unknown as CapabilityEvaluationEntry[]).push(evidenceEntry("tiles"))).toThrow(
      TypeError,
    );
  });

  it("excludes observation timestamps but retains schema evidence identity in the fingerprint", () => {
    const base = evidenceEntry("query", "supported", "supported", {
      evidence: [
        {
          kind: "protocol-default",
          truth: "supported",
          reference: "adapter:query",
          sourceFingerprint: SCHEMA_FINGERPRINT,
        },
        {
          kind: "metadata",
          truth: "supported",
          reference: "metadata:a",
          observedAt: "2026-07-13T12:00:00Z",
          sourceFingerprint: SCHEMA_FINGERPRINT,
        },
        {
          kind: "metadata",
          truth: "supported",
          reference: "metadata:b",
          observedAt: "2026-07-14T12:00:00Z",
          sourceFingerprint: SCHEMA_FINGERPRINT,
        },
      ],
    });
    const later = evidenceEntry("query", "supported", "supported", {
      evidence: [...base.evidence]
        .reverse()
        .map((item) =>
          item.kind === "metadata"
            ? { ...item, observedAt: item.reference === "metadata:a" ? "2026-07-15T12:00:00Z" : "2026-07-12T12:00:00Z" }
            : item,
        ),
    });
    const differentSchema = evidenceEntry("query", "supported", "supported", {
      evidence: base.evidence.map((item) => ({ ...item, sourceFingerprint: `sha256:${"b".repeat(64)}` })),
    });

    const first = evaluateCapabilityProfile([base]);
    const refreshed = evaluateCapabilityProfile([later]);
    const changed = evaluateCapabilityProfile([differentSchema]);

    expect(first.fingerprint).toBe(refreshed.fingerprint);
    expect(serializeCapabilityProfile(first)).not.toBe(serializeCapabilityProfile(refreshed));
    expect(first.fingerprint).not.toBe(changed.fingerprint);
  });

  it("gives facade and third-party evidence the same effective descriptor", () => {
    const facade = evidenceEntry("query", "supported", "supported", {
      evidence: [
        { kind: "declaration", truth: "supported", reference: "honua:facade" },
        { kind: "conformance", truth: "supported", reference: "honua:capabilities/query" },
      ],
    });
    const thirdParty = evidenceEntry("query", "supported", "supported", {
      evidence: [
        { kind: "protocol-default", truth: "supported", reference: "ogc-api-features" },
        { kind: "metadata", truth: "supported", reference: "GET /conformance" },
      ],
    });

    const projectDecision = (entry: CapabilityEvaluationEntry) => {
      const { evidence: _evidence, ...decision } = evaluateCapabilityProfile([entry]).entries[0]!;
      return decision;
    };
    expect(projectDecision(facade)).toEqual(projectDecision(thirdParty));
  });

  it.each([
    {
      label: "duplicate capability ids",
      run: () => evaluateCapabilityProfile([evidenceEntry("query"), evidenceEntry("query")]),
      message: /duplicate id query/,
    },
    {
      label: "duplicate constraint values",
      run: () =>
        evaluateCapabilityProfile([
          evidenceEntry("query", "supported", "supported", {
            constraints: { outputFormats: ["application/json", "application/json"] },
          }),
        ]),
      message: /duplicate value application\/json/,
    },
    {
      label: "non-positive limits",
      run: () =>
        evaluateCapabilityProfile([
          evidenceEntry("query", "supported", "supported", { constraints: { limits: { maxRecords: 0 } } }),
        ]),
      message: /positive safe integer/,
    },
    {
      label: "unsupported extension ids",
      run: () => evaluateCapabilityProfile([evidenceEntry("vendorOperation" as "query")]),
      message: /reverse-DNS extension id/,
    },
    {
      label: "contradictory observations",
      run: () =>
        evaluateCapabilityProfile([
          evidenceEntry("query", "supported", "supported", {
            evidence: [
              { kind: "protocol-default", truth: "supported", reference: "adapter:query" },
              { kind: "metadata", truth: "supported", reference: "metadata:a" },
              { kind: "metadata", truth: "unsupported", reference: "metadata:b" },
            ],
          }),
        ]),
      message: /conflicts with its observation evidence/,
    },
    {
      label: "effective profiles as inputs",
      run: () =>
        evaluateCapabilityProfile(
          evaluateCapabilityProfile([evidenceEntry("query")])
            .entries as unknown as readonly CapabilityEvaluationEntry[],
        ),
      message: /cacheable evidence, not a previously effective decision/,
    },
  ])("rejects $label", ({ run, message }) => {
    expect(run).toThrowError(message);
  });
});
