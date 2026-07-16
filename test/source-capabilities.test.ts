import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalStringify, sha256, toJsonValue } from "../src/query-planner/canonical.js";
import {
  CAPABILITY_EVIDENCE_FINGERPRINT_DOMAIN,
  CAPABILITY_EVIDENCE_PROFILE_KIND,
  CAPABILITY_EVIDENCE_PROFILE_VERSION,
  CAPABILITY_PROFILE_FINGERPRINT_DOMAIN,
  CAPABILITY_PROFILE_KIND,
  CAPABILITY_PROFILE_VERSION,
  CAPABILITY_SOURCE_ENDPOINT_FINGERPRINT_DOMAIN,
  type CapabilityEvaluationContext,
  type CapabilityEvaluationEntry,
  type CapabilityEvidenceProfileOptions,
  type CapabilitySourceEndpointIdentity,
  createCapabilityEvidenceProfile as createCapabilityEvidenceProfileRaw,
  createCapabilitySourceEndpointFingerprint,
  evaluateCapabilityProfile,
  parseCapabilityEvidenceProfile,
  parseCapabilityProfile,
  serializeCapabilityEvidenceProfile,
  serializeCapabilityProfile,
  verifyCapabilityEvidenceProfileSource,
} from "../src/source-capabilities.js";
import {
  CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS,
  CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS,
} from "../src/source-capability-limits.js";

const SCHEMA_FINGERPRINT = `sha256:${"a".repeat(64)}` as const;
const SOURCE_ENDPOINT = {
  endpoint: "https://example.test/ogc/features/collections/parcels",
  protocol: "ogc-features",
  sourceId: "parcels",
} as const satisfies CapabilitySourceEndpointIdentity;
const EVALUATED_AT = "2026-07-14T12:00:00Z";
const EXPIRES_AT = "2026-07-20T12:00:00Z";

function createCapabilityEvidenceProfile(
  entries: readonly CapabilityEvaluationEntry[],
  options: Omit<CapabilityEvidenceProfileOptions, "sourceEndpoint"> & {
    readonly sourceEndpoint?: CapabilitySourceEndpointIdentity;
  } = {},
) {
  return createCapabilityEvidenceProfileRaw(entries, { sourceEndpoint: SOURCE_ENDPOINT, ...options });
}

function evaluate(entries: readonly CapabilityEvaluationEntry[], context: CapabilityEvaluationContext = {}) {
  const sourceFingerprint = entries
    .flatMap((entry) => entry.evidence)
    .find((item) => item.sourceFingerprint !== undefined)?.sourceFingerprint;
  return evaluateCapabilityProfile(
    createCapabilityEvidenceProfile(entries, { sourceFingerprint: sourceFingerprint ?? SCHEMA_FINGERPRINT }),
    { evaluatedAt: EVALUATED_AT, ...context },
  );
}

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
            expiresAt: EXPIRES_AT,
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
    const profile = evaluate([entry]);

    expect(profile.entries[0]).toMatchObject({ effective, reasons });
  });

  it("intersects policy, environment, peer, and authorization without mutating cached evidence", () => {
    const cachedEvidence = [
      evidenceEntry("query", "supported", "supported", {
        requirements: { environments: ["worker"], peers: ["@duckdb/duckdb-wasm"] },
        authorizationScopes: ["dataset:parcels:read"],
      }),
    ] as const;

    const policyDisabled = evaluate(cachedEvidence, {
      policy: { deny: ["query"] },
      environment: "worker",
      availablePeers: ["@duckdb/duckdb-wasm"],
      authorization: { grantedScopes: ["dataset:parcels:read"] },
    });
    const unavailable = evaluate(cachedEvidence, { environment: "browser" });
    const authorizationRequired = evaluate(cachedEvidence, {
      environment: "worker",
      availablePeers: ["@duckdb/duckdb-wasm"],
    });
    const authorizationDenied = evaluate(cachedEvidence, {
      environment: "worker",
      availablePeers: ["@duckdb/duckdb-wasm"],
      authorization: { deniedScopes: ["dataset:parcels:read"] },
    });
    const supported = evaluate(cachedEvidence, {
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

    const first = evaluate(entries);
    const second = evaluate([...entries].reverse());

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

  it("keeps freshness refreshes out of semantic identity while binding schema changes", () => {
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
          expiresAt: EXPIRES_AT,
          sourceFingerprint: SCHEMA_FINGERPRINT,
        },
        {
          kind: "metadata",
          truth: "supported",
          reference: "metadata:b",
          observedAt: "2026-07-14T12:00:00Z",
          expiresAt: EXPIRES_AT,
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

    const first = evaluate([base]);
    const refreshed = evaluate([later]);
    const changed = evaluate([differentSchema]);
    const reevaluated = evaluateCapabilityProfile(createCapabilityEvidenceProfile([base]), {
      evaluatedAt: "2026-07-15T00:00:00Z",
    });

    expect(first.fingerprint).toBe(refreshed.fingerprint);
    expect(first.evidenceFingerprint).toBe(refreshed.evidenceFingerprint);
    expect(first.fingerprint).toBe(reevaluated.fingerprint);
    expect(first.evaluatedAt).not.toBe(reevaluated.evaluatedAt);
    expect(serializeCapabilityProfile(first)).not.toBe(serializeCapabilityProfile(refreshed));
    expect(first.fingerprint).not.toBe(changed.fingerprint);
  });

  it("gives facade and third-party evidence the same effective descriptor", () => {
    const facade = evidenceEntry("query", "supported", "supported", {
      evidence: [
        { kind: "declaration", truth: "supported", reference: "honua:facade" },
        {
          kind: "conformance",
          truth: "supported",
          reference: "honua:capabilities/query",
          observedAt: "2026-07-13T12:00:00Z",
          expiresAt: EXPIRES_AT,
        },
      ],
    });
    const thirdParty = evidenceEntry("query", "supported", "supported", {
      evidence: [
        { kind: "protocol-default", truth: "supported", reference: "ogc-api-features" },
        {
          kind: "metadata",
          truth: "supported",
          reference: "GET /conformance",
          observedAt: "2026-07-13T12:00:00Z",
          expiresAt: EXPIRES_AT,
        },
      ],
    });

    const projectDecision = (entry: CapabilityEvaluationEntry) => {
      const { evidence: _evidence, ...decision } = evaluate([entry]).entries[0]!;
      return decision;
    };
    expect(projectDecision(facade)).toEqual(projectDecision(thirdParty));
  });

  it("preserves explicit empty constraint sets as observed-none identity", () => {
    const explicit = evaluate([
      evidenceEntry("query", "supported", "supported", {
        constraints: {
          inputFormats: [],
          outputFormats: [],
          filterOperators: [],
          spatialPredicates: [],
          temporalPredicates: [],
          supportedCrs: [],
          pagination: { modes: [] },
        },
      }),
    ]);
    const omitted = evaluate([evidenceEntry("query")]);

    expect(explicit.entries[0]?.constraints).toEqual({
      inputFormats: [],
      outputFormats: [],
      filterOperators: [],
      spatialPredicates: [],
      temporalPredicates: [],
      supportedCrs: [],
      pagination: { modes: [] },
    });
    expect(explicit.fingerprint).not.toBe(omitted.fingerprint);
  });

  it("retains execution requirements in decisions and semantic identity", () => {
    const node = evaluate(
      [evidenceEntry("query", "supported", "supported", { requirements: { environments: ["node"] } })],
      { environment: "node" },
    );
    const edge = evaluate(
      [evidenceEntry("query", "supported", "supported", { requirements: { environments: ["edge"] } })],
      { environment: "edge" },
    );

    expect(node.entries[0]).toMatchObject({ effective: "supported", requirements: { environments: ["node"] } });
    expect(edge.entries[0]).toMatchObject({ effective: "supported", requirements: { environments: ["edge"] } });
    expect(node.fingerprint).not.toBe(edge.fingerprint);
  });

  it("fails closed when freshness is not evaluated or observed evidence is stale", () => {
    const entry = evidenceEntry("query");
    const profile = createCapabilityEvidenceProfile([entry]);
    const withoutClock = evaluateCapabilityProfile(profile);
    const stale = evaluateCapabilityProfile(profile, { evaluatedAt: "2026-07-21T12:00:00Z" });
    const fresh = evaluateCapabilityProfile(profile, { evaluatedAt: EVALUATED_AT });
    const nanosecondWindow = {
      ...entry,
      evidence: entry.evidence.map((item) =>
        item.kind === "metadata"
          ? {
              ...item,
              observedAt: "2026-07-14T12:00:00.000000001Z",
              expiresAt: "2026-07-14T12:00:00.000000003Z",
            }
          : item,
      ),
    } as CapabilityEvaluationEntry;

    expect(withoutClock.entries[0]).toMatchObject({
      effective: "unknown",
      reasons: ["freshness-not-evaluated"],
    });
    expect(stale.entries[0]).toMatchObject({ effective: "unknown", reasons: ["evidence-stale"] });
    expect(fresh.entries[0]?.effective).toBe("supported");
    expect(
      evaluateCapabilityProfile(createCapabilityEvidenceProfile([nanosecondWindow]), {
        evaluatedAt: "2026-07-14T12:00:00.000000002Z",
      }).entries[0]?.effective,
    ).toBe("supported");
    expect(
      evaluateCapabilityProfile(createCapabilityEvidenceProfile([nanosecondWindow]), {
        evaluatedAt: "2026-07-14T12:00:00.000000003Z",
      }).entries[0],
    ).toMatchObject({ effective: "unknown", reasons: ["evidence-stale"] });
  });

  it("requires explicit, ordered freshness bounds on observed evidence", () => {
    const entry = evidenceEntry("query");
    const missingExpiry = {
      ...entry,
      evidence: entry.evidence.map((item) => {
        if (item.kind !== "metadata") return item;
        const { expiresAt: _expiresAt, ...withoutExpiry } = item;
        return withoutExpiry;
      }),
    } as CapabilityEvaluationEntry;
    const reversedExpiry = {
      ...entry,
      evidence: entry.evidence.map((item) =>
        item.kind === "metadata" ? { ...item, expiresAt: "2026-07-12T12:00:00Z" } : item,
      ),
    } as CapabilityEvaluationEntry;

    expect(() => evaluate([missingExpiry])).toThrow(/requires observedAt and expiresAt/);
    expect(() => evaluate([reversedExpiry])).toThrow(/later than observedAt/);
  });

  it("validates complete resolved CRS definitions and official PROJJSON", () => {
    const definitionAxisOrder = {
      state: "known",
      source: "crs-definition",
      axes: [
        { name: "longitude", direction: "east", unit: "degree" },
        { name: "latitude", direction: "north", unit: "degree" },
      ],
    } as const;
    const authority = {
      kind: "authority",
      authority: "OGC",
      code: "CRS84",
      definitionAxisOrder,
    } as const;
    const projjson = {
      kind: "projjson",
      projjson: {
        $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
        type: "GeographicCRS",
        name: "WGS 84",
        datum: {
          type: "GeodeticReferenceFrame",
          name: "World Geodetic System 1984",
          ellipsoid: {
            type: "Ellipsoid",
            name: "WGS 84",
            semi_major_axis: 6378137,
            inverse_flattening: 298.257223563,
          },
        },
      },
      definitionAxisOrder,
    } as const;

    expect(
      evaluate([
        evidenceEntry("query", "supported", "supported", {
          constraints: { supportedCrs: [authority, projjson] },
        }),
      ]).entries[0]?.constraints?.supportedCrs,
    ).toHaveLength(2);
  });

  it.each([
    {
      label: "an authority without its mandatory identity and axis order",
      crs: { kind: "authority" },
      message: /authority/,
    },
    {
      label: "an incomplete definition axis order",
      crs: {
        kind: "authority",
        authority: "OGC",
        code: "CRS84",
        definitionAxisOrder: {
          state: "known",
          source: "crs-definition",
          axes: [{ name: "longitude", direction: "east", unit: "degree" }],
        },
      },
      message: /at least two axes/,
    },
    {
      label: "structurally incomplete PROJJSON",
      crs: {
        kind: "projjson",
        projjson: { type: "ProjectedCRS", name: "Missing required containers" },
        definitionAxisOrder: { state: "unknown", reason: "unrecognized" },
      },
      message: /base_crs|official PROJJSON/,
    },
  ])("rejects $label", ({ crs, message }) => {
    expect(() =>
      evaluate([
        evidenceEntry("query", "supported", "supported", {
          constraints: { supportedCrs: [crs] },
        } as unknown as Partial<CapabilityEvaluationEntry>),
      ]),
    ).toThrowError(message);
  });

  it.each([
    {
      label: "entry sentinel",
      key: "UNKNOWN_KEY_SENTINEL",
      run: () =>
        evaluate([
          { ...evidenceEntry("query"), UNKNOWN_KEY_SENTINEL: "supported" } as unknown as CapabilityEvaluationEntry,
        ]),
    },
    {
      label: "authorization scope entry",
      key: "authorisationScopes",
      run: () =>
        evaluate([
          {
            ...evidenceEntry("query"),
            authorizationScopes: ["dataset:read"],
            authorisationScopes: ["dataset:read"],
          } as unknown as CapabilityEvaluationEntry,
        ]),
    },
    {
      label: "requirement entry",
      key: "requirement",
      run: () =>
        evaluate([
          {
            ...evidenceEntry("query"),
            requirements: { peers: ["peer"] },
            requirement: { peers: ["peer"] },
          } as unknown as CapabilityEvaluationEntry,
        ]),
    },
    {
      label: "evidence",
      key: "truh",
      run: () => {
        const entry = evidenceEntry("query");
        return evaluate([
          {
            ...entry,
            evidence: entry.evidence.map((item, index) => (index === 0 ? { ...item, truh: "supported" } : item)),
          } as CapabilityEvaluationEntry,
        ]);
      },
    },
    {
      label: "context",
      key: "environmnt",
      run: () =>
        evaluate([evidenceEntry("query")], {
          environment: "browser",
          environmnt: "browser",
        } as CapabilityEvaluationContext),
    },
    {
      label: "policy",
      key: "denny",
      run: () =>
        evaluate([evidenceEntry("query")], {
          policy: { deny: ["query"], denny: ["query"] },
        } as unknown as CapabilityEvaluationContext),
    },
    {
      label: "authorization",
      key: "grantedScope",
      run: () =>
        evaluate([evidenceEntry("query")], {
          authorization: { grantedScopes: [], grantedScope: [] },
        } as unknown as CapabilityEvaluationContext),
    },
    {
      label: "constraints",
      key: "outputFormat",
      run: () =>
        evaluate([
          evidenceEntry("query", "supported", "supported", {
            constraints: { outputFormats: ["application/json"], outputFormat: ["application/json"] },
          } as unknown as Partial<CapabilityEvaluationEntry>),
        ]),
    },
    {
      label: "requirements",
      key: "peer",
      run: () =>
        evaluate([
          evidenceEntry("query", "supported", "supported", {
            requirements: { peers: ["peer"], peer: ["peer"] },
          } as unknown as Partial<CapabilityEvaluationEntry>),
        ]),
    },
    {
      label: "pagination",
      key: "mode",
      run: () =>
        evaluate([
          evidenceEntry("query", "supported", "supported", {
            constraints: { pagination: { modes: ["offset"], mode: ["offset"] } },
          } as unknown as Partial<CapabilityEvaluationEntry>),
        ]),
    },
    {
      label: "limits",
      key: "maxRecord",
      run: () =>
        evaluate([
          evidenceEntry("query", "supported", "supported", {
            constraints: { limits: { maxRecords: 1, maxRecord: 1 } },
          } as unknown as Partial<CapabilityEvaluationEntry>),
        ]),
    },
  ])("rejects unknown keys on $label objects", ({ key, run }) => {
    let error: unknown;
    try {
      run();
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/contains 1 unknown key/);
    expect(String(error)).not.toContain(key);
  });

  it("ignores inherited Object.prototype fields and restores the prototype", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "policy");
    try {
      Object.defineProperty(Object.prototype, "policy", {
        value: { deny: ["query"] },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      expect(evaluate([evidenceEntry("query")]).entries[0]?.effective).toBe("supported");
    } finally {
      if (previous === undefined) delete (Object.prototype as { policy?: unknown }).policy;
      else Object.defineProperty(Object.prototype, "policy", previous);
    }
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const context = Object.defineProperty({ evaluatedAt: EVALUATED_AT }, "policy", {
      enumerable: true,
      get() {
        invoked = true;
        return { deny: ["query"] };
      },
    });

    const profile = createCapabilityEvidenceProfile([evidenceEntry("query")]);
    expect(() => evaluateCapabilityProfile(profile, context)).toThrow(/accessors are not supported/);
    expect(invoked).toBe(false);
  });

  it("enforces entry, evidence, and set count bounds", () => {
    expect(() => evaluate(Array.from({ length: 257 }, () => evidenceEntry("query")))).toThrow(/maximum count 256/);
    const entry = evidenceEntry("query");
    expect(() =>
      evaluate([
        {
          ...entry,
          evidence: [
            ...entry.evidence,
            ...Array.from({ length: 63 }, (_, index) => ({
              kind: "declaration" as const,
              truth: "supported" as const,
              reference: `declaration:${index}`,
            })),
          ],
        },
      ]),
    ).toThrow(/maximum count 64/);
    expect(() =>
      evaluate([
        evidenceEntry("query", "supported", "supported", {
          constraints: { outputFormats: Array.from({ length: 1_025 }, (_, index) => `format/${index}`) },
        }),
      ]),
    ).toThrow(/maximum count 1024/);
    expect(() =>
      evaluate([
        evidenceEntry("query", "supported", "supported", {
          constraints: {
            extensions: Object.fromEntries(
              Array.from({ length: 65 }, (_, index) => [`com.example.key${index}`, index]),
            ),
          },
        }),
      ]),
    ).toThrow(/maximum count 64/);
  });

  it("rejects hostile graph depth and total bytes with TypeError rather than RangeError", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 20; index++) nested = { nested };
    const deepRun = () =>
      evaluate([
        evidenceEntry("query", "supported", "supported", {
          constraints: { extensions: { "com.example.deep": nested } },
        } as unknown as Partial<CapabilityEvaluationEntry>),
      ]);
    const oversizedRun = () =>
      evaluate([
        evidenceEntry("query", "supported", "supported", {
          constraints: { extensions: { "com.example.large": "x".repeat(2 * 1_024 * 1_024 + 1) } },
        }),
      ]);

    expect(deepRun).toThrow(TypeError);
    expect(deepRun).toThrow(/maximum graph depth 16/);
    expect(oversizedRun).toThrow(TypeError);
    expect(oversizedRun).toThrow(/byte limit/);

    let hostileProfile: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 100; index++) hostileProfile = { nested: hostileProfile };
    expect(() => serializeCapabilityProfile(hostileProfile as never)).toThrow(TypeError);
    expect(() => serializeCapabilityProfile(hostileProfile as never)).toThrow(/must be evaluated or parsed/);
  });

  it.each([
    {
      label: "duplicate capability ids",
      run: () => evaluate([evidenceEntry("query"), evidenceEntry("query")]),
      message: /duplicate id query/,
    },
    {
      label: "duplicate constraint values",
      run: () =>
        evaluate([
          evidenceEntry("query", "supported", "supported", {
            constraints: { outputFormats: ["application/json", "application/json"] },
          }),
        ]),
      message: /duplicate value/,
    },
    {
      label: "non-positive limits",
      run: () =>
        evaluate([evidenceEntry("query", "supported", "supported", { constraints: { limits: { maxRecords: 0 } } })]),
      message: /positive safe integer/,
    },
    {
      label: "unsupported extension ids",
      run: () => evaluate([evidenceEntry("vendorOperation" as "query")]),
      message: /reverse-DNS extension id/,
    },
    {
      label: "contradictory observations",
      run: () =>
        evaluate([
          evidenceEntry("query", "supported", "supported", {
            evidence: [
              { kind: "protocol-default", truth: "supported", reference: "adapter:query" },
              {
                kind: "metadata",
                truth: "supported",
                reference: "metadata:a",
                observedAt: "2026-07-13T12:00:00Z",
                expiresAt: EXPIRES_AT,
              },
              {
                kind: "metadata",
                truth: "unsupported",
                reference: "metadata:b",
                observedAt: "2026-07-13T12:00:00Z",
                expiresAt: EXPIRES_AT,
              },
            ],
          }),
        ]),
      message: /conflicts with its observation evidence/,
    },
    {
      label: "effective profiles as inputs",
      run: () =>
        evaluate(evaluate([evidenceEntry("query")]).entries as unknown as readonly CapabilityEvaluationEntry[]),
      message: /cacheable evidence, not a previously effective decision/,
    },
  ])("rejects $label", ({ run, message }) => {
    expect(run).toThrowError(message);
  });

  it("creates a versioned, fingerprinted, deeply immutable static evidence envelope", () => {
    const first = createCapabilityEvidenceProfile([evidenceEntry("tiles"), evidenceEntry("query")]);
    const second = createCapabilityEvidenceProfile([evidenceEntry("query"), evidenceEntry("tiles")]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: CAPABILITY_EVIDENCE_PROFILE_KIND,
      version: CAPABILITY_EVIDENCE_PROFILE_VERSION,
      sourceFingerprint: SCHEMA_FINGERPRINT,
      sourceEndpointFingerprint: createCapabilitySourceEndpointFingerprint(SOURCE_ENDPOINT),
      entries: [{ id: "query" }, { id: "tiles" }],
    });
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.evidence)).toBe(true);
    expect(parseCapabilityEvidenceProfile(serializeCapabilityEvidenceProfile(first))).toEqual(first);
  });

  it("sorts set values by canonical JSON UTF-8 bytes and pins both capability digests", () => {
    const supplementary = "application/\u{10000}";
    const privateUseBmp = "application/\u{e000}";
    const input = evidenceEntry("query", "supported", "not-observed", {
      constraints: { inputFormats: [supplementary, privateUseBmp] },
    });
    const evidenceProfile = createCapabilityEvidenceProfile([input]);
    const reordered = createCapabilityEvidenceProfile([
      { ...input, constraints: { inputFormats: [privateUseBmp, supplementary] } },
    ]);
    const evaluated = evaluateCapabilityProfile(evidenceProfile, { evaluatedAt: EVALUATED_AT });
    const reorderedEvaluated = evaluateCapabilityProfile(reordered, { evaluatedAt: EVALUATED_AT });

    expect(evidenceProfile.entries[0]?.constraints?.inputFormats).toEqual([privateUseBmp, supplementary]);
    expect(reordered.fingerprint).toBe(evidenceProfile.fingerprint);
    expect(serializeCapabilityEvidenceProfile(reordered)).toBe(serializeCapabilityEvidenceProfile(evidenceProfile));
    expect(serializeCapabilityProfile(reorderedEvaluated)).toBe(serializeCapabilityProfile(evaluated));
    expect(CAPABILITY_EVIDENCE_FINGERPRINT_DOMAIN).toBe("honua:capability-evidence:1.0");
    expect(CAPABILITY_SOURCE_ENDPOINT_FINGERPRINT_DOMAIN).toBe("honua:capability-source-endpoint:1.0");
    expect(CAPABILITY_PROFILE_FINGERPRINT_DOMAIN).toBe("honua:capabilities:1.0");
    expect({ evidence: evidenceProfile.fingerprint, evaluated: evaluated.fingerprint }).toEqual({
      evidence: "sha256:25a04940c1f7bfeff22544b49fc062c49bcff7b4ea1d04bf5d12e76a4e4e970d",
      evaluated: "sha256:e5e5b473d1def190c7b91db91950060164e3c08e17dcacb06592d002f4432eb9",
    });
  });

  it("pins the five cross-SDK fingerprint domain vectors", () => {
    const projection = canonicalStringify(toJsonValue({ set: ["\u{e000}", "\u{10000}"] }));
    expect(projection).toBe('{"set":["","𐀀"]}');
    expect(
      Array.from(new TextEncoder().encode(projection), (value) => value.toString(16).padStart(2, "0")).join(""),
    ).toBe("7b22736574223a5b22ee8080222c22f0908080225d7d");
    expect(
      [
        "honua:schema:2.0",
        CAPABILITY_SOURCE_ENDPOINT_FINGERPRINT_DOMAIN,
        CAPABILITY_EVIDENCE_FINGERPRINT_DOMAIN,
        CAPABILITY_PROFILE_FINGERPRINT_DOMAIN,
        "honua:descriptor:2.0",
      ].map((domain) => sha256(`${domain}\n${projection}`)),
    ).toEqual([
      "sha256:b3a928e3b41ca6a272bcc8febdfa79b1a72fdd0f13ac776306bd0689eefc6ce2",
      "sha256:92cbdfa824a6a5a59f9523ff23910c127195604537cd1d360335d091c9409f45",
      "sha256:00a7a0bd21d15452d2420ad57174212ba486d0bf9928cc8dc25cc0193c4fe531",
      "sha256:764a6298073ad7251fad80285cb277f804cef5c7f48dfb5f838eb161e5d5f17d",
      "sha256:58c0e5e9c0ee7477d8e7ef9b9e4035da9dfcebfce55738f247dd3da456b69d58",
    ]);
  });

  it("pins the exact ADR capability example fingerprints", () => {
    const sourceFingerprint = "sha256:a2c9cb525692cf2e224b088147f1b23ae99bce3c974ba023ab4898f28bc79aa8" as const;
    const evidence = createCapabilityEvidenceProfile([
      {
        id: "query",
        claimed: "supported",
        observed: "supported",
        evidence: [
          {
            kind: "protocol-default",
            truth: "supported",
            reference: "ogcapi-features:core",
            sourceFingerprint,
          },
          {
            kind: "conformance",
            truth: "supported",
            reference: "ogcapi-features:conf/core",
            observedAt: "2026-07-13T12:00:00Z",
            expiresAt: "2026-07-20T12:00:00Z",
            sourceFingerprint,
          },
        ],
        constraints: {
          outputFormats: ["application/geo+json"],
          filterOperators: ["eq", "in", "intersects"],
          spatialPredicates: ["intersects"],
          pagination: { modes: ["offset"], maxPageSize: 10_000 },
          limits: { maxRecords: 100_000 },
        },
      },
    ]);
    const evaluated = evaluateCapabilityProfile(evidence, { evaluatedAt: EVALUATED_AT });

    expect(evidence.entries[0]?.evidence.map((item) => item.kind)).toEqual(["conformance", "protocol-default"]);
    expect(evidence.sourceEndpointFingerprint).toBe(
      "sha256:4387aab98b418ae7332c05ce480c880f798f1b9e39d7a185c258b448bd99f2ff",
    );
    expect(evidence.fingerprint).toBe("sha256:239e833ecaa68009bd0b83b741965dcb23505461badb3431da91d3d26223fef4");
    expect(evaluated.fingerprint).toBe("sha256:6c2db7216f86eb9adf8f952041887ec6702d356f506895a7f68cb5e847e168c8");
  });

  it("enforces one coherent source identity across an evidence profile", () => {
    const otherFingerprint = `sha256:${"b".repeat(64)}` as const;
    const mixed = evidenceEntry("query", "supported", "supported", {
      evidence: evidenceEntry("query").evidence.map((item, index) => ({
        ...item,
        sourceFingerprint: index === 0 ? SCHEMA_FINGERPRINT : otherFingerprint,
      })),
    });

    expect(() => createCapabilityEvidenceProfile([mixed])).toThrow(/multiple source fingerprints/);
    expect(() =>
      createCapabilityEvidenceProfile([evidenceEntry("query")], { sourceFingerprint: otherFingerprint }),
    ).toThrow(/does not match expected/);

    const valid = createCapabilityEvidenceProfile([evidenceEntry("query")]);
    const forged = JSON.parse(serializeCapabilityEvidenceProfile(valid)) as Record<string, unknown>;
    forged.sourceFingerprint = otherFingerprint;
    expect(() => parseCapabilityEvidenceProfile(forged)).toThrow(/does not match expected/);
    const endpointForged = JSON.parse(serializeCapabilityEvidenceProfile(valid)) as Record<string, unknown>;
    endpointForged.sourceEndpointFingerprint = otherFingerprint;
    expect(() => parseCapabilityEvidenceProfile(endpointForged)).toThrow(/fingerprint does not match/);
  });

  it("derives a normalized credential-free endpoint digest and never transports raw endpoint coordinates", () => {
    const normalized = createCapabilitySourceEndpointFingerprint(SOURCE_ENDPOINT);
    const equivalent = createCapabilitySourceEndpointFingerprint({
      endpoint: "HTTPS://EXAMPLE.TEST/ogc/features/collections/%70arcels/",
      protocol: "ogc-features",
      sourceId: "parcels",
    });
    const differentProtocol = createCapabilitySourceEndpointFingerprint({
      ...SOURCE_ENDPOINT,
      protocol: "wfs",
    });
    const profile = createCapabilityEvidenceProfile([evidenceEntry("query")]);
    const wire = serializeCapabilityEvidenceProfile(profile);

    expect(normalized).toBe(equivalent);
    expect(normalized).not.toBe(differentProtocol);
    expect(profile.sourceEndpointFingerprint).toBe(normalized);
    expect(wire).not.toContain(SOURCE_ENDPOINT.endpoint);
    expect(wire).not.toContain(SOURCE_ENDPOINT.sourceId);
  });

  it.each([
    {
      label: "URL user-info",
      identity: { ...SOURCE_ENDPOINT, endpoint: "https://user:ENDPOINT_SECRET@example.test/collections/parcels" },
      secret: "ENDPOINT_SECRET",
    },
    {
      label: "signed or credential query",
      identity: { ...SOURCE_ENDPOINT, endpoint: "https://example.test/collections/parcels?access_token=QUERY_SECRET" },
      secret: "QUERY_SECRET",
    },
    {
      label: "fragment data",
      identity: { ...SOURCE_ENDPOINT, endpoint: "https://example.test/collections/parcels#FRAGMENT_SECRET" },
      secret: "FRAGMENT_SECRET",
    },
    {
      label: "encoded credential-shaped path",
      identity: {
        ...SOURCE_ENDPOINT,
        endpoint: "https://example.test/collections/access_token%3DPATH_SECRET",
      },
      secret: "PATH_SECRET",
    },
    {
      label: "credential-shaped source discriminator",
      identity: { ...SOURCE_ENDPOINT, sourceId: "Bearer SOURCE_ID_SECRET" },
      secret: "SOURCE_ID_SECRET",
    },
    {
      label: "invalid protocol discriminator",
      identity: { ...SOURCE_ENDPOINT, protocol: "PROTOCOL_SECRET" },
      secret: "PROTOCOL_SECRET",
    },
    {
      label: "caller-sensitive unknown endpoint key",
      identity: { ...SOURCE_ENDPOINT, ENDPOINT_KEY_SECRET: true },
      secret: "ENDPOINT_KEY_SECRET",
    },
  ])("rejects $label before endpoint hashing without echoing caller data", ({ identity, secret }) => {
    let error: unknown;
    try {
      createCapabilitySourceEndpointFingerprint(identity as CapabilitySourceEndpointIdentity);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(secret);
  });

  it("requires endpoint coordinates at evidence creation", () => {
    expect(() =>
      createCapabilityEvidenceProfileRaw([evidenceEntry("query")], {
        sourceFingerprint: SCHEMA_FINGERPRINT,
      } as CapabilityEvidenceProfileOptions),
    ).toThrow(/sourceEndpoint is required/);
  });

  it("rejects same-schema capability replay across endpoints", () => {
    const otherEndpoint = {
      ...SOURCE_ENDPOINT,
      endpoint: "https://other.example.test/ogc/features/collections/parcels",
    } as const;
    const current = createCapabilityEvidenceProfile([evidenceEntry("query")]);
    const other = createCapabilityEvidenceProfile([evidenceEntry("query")], { sourceEndpoint: otherEndpoint });
    const wire = serializeCapabilityEvidenceProfile(current);

    expect(other.sourceFingerprint).toBe(current.sourceFingerprint);
    expect(other.sourceEndpointFingerprint).not.toBe(current.sourceEndpointFingerprint);
    expect(other.fingerprint).not.toBe(current.fingerprint);
    expect(() =>
      parseCapabilityEvidenceProfile(wire, {
        expectedSourceFingerprint: SCHEMA_FINGERPRINT,
        expectedSourceEndpoint: otherEndpoint,
      }),
    ).toThrow(/does not match current source endpoint/);
    expect(() => parseCapabilityEvidenceProfile(wire, { expectedSourceFingerprint: SCHEMA_FINGERPRINT })).toThrow(
      /requires both expectedSourceFingerprint and expectedSourceEndpoint/,
    );
    expect(() => parseCapabilityEvidenceProfile(wire, { expectedSourceEndpoint: SOURCE_ENDPOINT })).toThrow(
      /requires both expectedSourceFingerprint and expectedSourceEndpoint/,
    );
  });

  it("round-trips evaluated transport only after replaying its retained context", () => {
    const staticProfile = createCapabilityEvidenceProfile([
      evidenceEntry("query", "supported", "supported", {
        requirements: { environments: ["worker"], peers: ["peer-a"] },
        authorizationScopes: ["dataset:read"],
      }),
    ]);
    const evaluated = evaluateCapabilityProfile(staticProfile, {
      evaluatedAt: EVALUATED_AT,
      environment: "worker",
      availablePeers: ["peer-a"],
      authorization: { grantedScopes: ["dataset:read"] },
    });
    const parsed = parseCapabilityProfile(serializeCapabilityProfile(evaluated));

    expect(parsed).toEqual(evaluated);
    expect(parsed.evidenceFingerprint).toBe(staticProfile.fingerprint);
    expect(parsed.sourceFingerprint).toBe(SCHEMA_FINGERPRINT);
    expect(parsed.sourceEndpointFingerprint).toBe(createCapabilitySourceEndpointFingerprint(SOURCE_ENDPOINT));
    expect(parsed.evaluatedAt).toBe(EVALUATED_AT);
    expect(parsed.validUntil).toBe(EXPIRES_AT);
    expect(parsed.context).toEqual({
      environment: "worker",
      availablePeers: ["peer-a"],
      authorization: { grantedScopes: ["dataset:read"], deniedScopes: [] },
    });
  });

  it.each([
    {
      label: "effective decision",
      mutate: (profile: Record<string, unknown>) => {
        (profile.entries as Array<Record<string, unknown>>)[0]!.effective = "unsupported";
      },
    },
    {
      label: "decision reason",
      mutate: (profile: Record<string, unknown>) => {
        (profile.entries as Array<Record<string, unknown>>)[0]!.reasons = ["unsupported-by-claim"];
      },
    },
    {
      label: "validity boundary",
      mutate: (profile: Record<string, unknown>) => {
        profile.validUntil = "2026-07-21T12:00:00Z";
      },
    },
    {
      label: "profile fingerprint",
      mutate: (profile: Record<string, unknown>) => {
        profile.fingerprint = `sha256:${"f".repeat(64)}`;
      },
    },
    {
      label: "evidence fingerprint",
      mutate: (profile: Record<string, unknown>) => {
        profile.evidenceFingerprint = `sha256:${"e".repeat(64)}`;
      },
    },
    {
      label: "profile kind",
      mutate: (profile: Record<string, unknown>) => {
        profile.kind = "honua.capabilities.future";
      },
    },
    {
      label: "profile version",
      mutate: (profile: Record<string, unknown>) => {
        profile.version = "2.0";
      },
    },
    {
      label: "required source identity",
      mutate: (profile: Record<string, unknown>) => {
        delete profile.sourceFingerprint;
      },
    },
    {
      label: "required source endpoint identity",
      mutate: (profile: Record<string, unknown>) => {
        delete profile.sourceEndpointFingerprint;
      },
    },
    {
      label: "source endpoint fingerprint",
      mutate: (profile: Record<string, unknown>) => {
        profile.sourceEndpointFingerprint = `sha256:${"d".repeat(64)}`;
      },
    },
    {
      label: "unknown root field",
      mutate: (profile: Record<string, unknown>) => {
        profile.verified = true;
      },
    },
    {
      label: "unknown decision field",
      mutate: (profile: Record<string, unknown>) => {
        (profile.entries as Array<Record<string, unknown>>)[0]!.confidence = 1;
      },
    },
  ])("rejects a forged transported $label", ({ mutate }) => {
    const evaluated = evaluate([evidenceEntry("query")]);
    const transported = JSON.parse(serializeCapabilityProfile(evaluated)) as Record<string, unknown>;
    mutate(transported);
    expect(() => parseCapabilityProfile(transported)).toThrow(TypeError);
  });

  it("reports nullable evaluation time and a conservative freshness boundary", () => {
    const evidence = createCapabilityEvidenceProfile([evidenceEntry("query")]);
    const unevaluated = evaluateCapabilityProfile(evidence);
    const stale = evaluateCapabilityProfile(evidence, { evaluatedAt: "2026-07-21T12:00:00Z" });

    expect(unevaluated).toMatchObject({ evaluatedAt: null, validUntil: null });
    expect(stale).toMatchObject({
      evaluatedAt: "2026-07-21T12:00:00Z",
      validUntil: "2026-07-21T12:00:00Z",
    });
  });

  it("rejects undefined members and unpaired UTF-16 surrogates before canonicalization", () => {
    const undefinedMember = {
      ...evidenceEntry("query"),
      constraints: { outputFormats: undefined },
    } as unknown as CapabilityEvaluationEntry;
    const unpairedValue = evidenceEntry("query", "supported", "supported", {
      constraints: { outputFormats: ["bad\ud800"] },
    });
    const unpairedKey = evidenceEntry("query", "supported", "supported", {
      constraints: { extensions: { ["com.example.\udc00"]: true } as never },
    });

    expect(() => createCapabilityEvidenceProfile([undefinedMember])).toThrow(/must not be undefined/);
    expect(() => createCapabilityEvidenceProfile([unpairedValue])).toThrow(/unpaired high Unicode surrogate/);
    expect(() => createCapabilityEvidenceProfile([unpairedKey])).toThrow(/unpaired low Unicode surrogate/);
    expect(() => parseCapabilityEvidenceProfile('{"kind":"honua.capability-evidence","bad":"\\ud800"}')).toThrow(
      /unpaired high Unicode surrogate/,
    );
    const serialized = serializeCapabilityEvidenceProfile(createCapabilityEvidenceProfile([evidenceEntry("query")]));
    const duplicateKeySentinel = "DUPLICATE_OBJECT_KEY_SENTINEL";
    expect(serialized.startsWith("{")).toBe(true);
    const duplicateName = `{"${duplicateKeySentinel}":true,"${duplicateKeySentinel}":false,${serialized.slice(1)}`;
    let duplicateError: unknown;
    try {
      parseCapabilityEvidenceProfile(duplicateName);
    } catch (cause) {
      duplicateError = cause;
    }
    expect(duplicateError).toBeInstanceOf(TypeError);
    expect(String(duplicateError)).toMatch(/duplicate object name/);
    expect(String(duplicateError)).not.toContain(duplicateKeySentinel);
  });

  it("caps supported CRS definitions at 64 before heavy validation", () => {
    expect(() =>
      createCapabilityEvidenceProfile([
        evidenceEntry("query", "supported", "supported", {
          constraints: { supportedCrs: Array.from({ length: 65 }, () => null) as never },
        }),
      ]),
    ).toThrow(/maximum count 64/);
  });

  it("keeps repeat evaluation synchronous and reuses the validated static envelope", () => {
    const staticProfile = createCapabilityEvidenceProfile([
      evidenceEntry("query", "supported", "supported", {
        constraints: { outputFormats: ["application/geo+json"] },
      }),
    ]);

    for (let index = 0; index < 100; index++) {
      const evaluated = evaluateCapabilityProfile(staticProfile, {
        evaluatedAt: EVALUATED_AT,
        policy: { deny: index % 2 === 0 ? [] : ["query"] },
      });
      expect(evaluated).not.toBeInstanceOf(Promise);
      expect(evaluated.entries[0]?.constraints).toBe(staticProfile.entries[0]?.constraints);
    }
    expect(() => evaluateCapabilityProfile(staticProfile.entries as never)).toThrow(/must be created or parsed/);
  });

  it("requires and verifies the current SourceSchemaV2 identity at cache boundaries", () => {
    const unboundEntry = evidenceEntry("query", "supported", "supported", {
      evidence: evidenceEntry("query").evidence.map(({ sourceFingerprint: _sourceFingerprint, ...item }) => item),
    });
    expect(() => createCapabilityEvidenceProfile([unboundEntry])).toThrow(/requires one SourceSchemaV2/);

    const current = createCapabilityEvidenceProfile([evidenceEntry("query")]);
    const wire = serializeCapabilityEvidenceProfile(current);
    const unboundWire = JSON.parse(wire) as Record<string, unknown>;
    delete unboundWire.sourceFingerprint;
    expect(() => parseCapabilityEvidenceProfile(unboundWire)).toThrow(/sourceFingerprint is required/);
    const endpointUnboundWire = JSON.parse(wire) as Record<string, unknown>;
    delete endpointUnboundWire.sourceEndpointFingerprint;
    expect(() => parseCapabilityEvidenceProfile(endpointUnboundWire)).toThrow(/sourceEndpointFingerprint is required/);
    const staleFingerprint = `sha256:${"c".repeat(64)}` as const;
    expect(
      parseCapabilityEvidenceProfile(wire, {
        expectedSourceFingerprint: SCHEMA_FINGERPRINT,
        expectedSourceEndpoint: SOURCE_ENDPOINT,
      }),
    ).toEqual(current);
    expect(verifyCapabilityEvidenceProfileSource(current, SCHEMA_FINGERPRINT, SOURCE_ENDPOINT)).toBe(current);
    expect(() =>
      parseCapabilityEvidenceProfile(wire, {
        expectedSourceFingerprint: staleFingerprint,
        expectedSourceEndpoint: SOURCE_ENDPOINT,
      }),
    ).toThrow(/does not match current source/);
    expect(() => verifyCapabilityEvidenceProfileSource(current, staleFingerprint, SOURCE_ENDPOINT)).toThrow(
      /does not match current source/,
    );

    const evaluatedWire = serializeCapabilityProfile(evaluateCapabilityProfile(current, { evaluatedAt: EVALUATED_AT }));
    expect(
      parseCapabilityProfile(evaluatedWire, {
        expectedSourceFingerprint: SCHEMA_FINGERPRINT,
        expectedSourceEndpoint: SOURCE_ENDPOINT,
      }),
    ).toMatchObject({
      sourceFingerprint: SCHEMA_FINGERPRINT,
    });
    expect(() =>
      parseCapabilityProfile(evaluatedWire, {
        expectedSourceFingerprint: staleFingerprint,
        expectedSourceEndpoint: SOURCE_ENDPOINT,
      }),
    ).toThrow(/does not match current source/);
  });

  it.each([
    {
      label: "credential-bearing evidence URL",
      entry: evidenceEntry("query", "supported", "supported", {
        evidence: [
          {
            kind: "protocol-default",
            truth: "supported",
            reference: "https://user:password@example.test/defaults?access_token=REFERENCE_SECRET",
            sourceFingerprint: SCHEMA_FINGERPRINT,
          },
          evidenceEntry("query").evidence[1]!,
        ],
      }),
      secret: "REFERENCE_SECRET",
    },
    {
      label: "authorization-shaped peer",
      entry: evidenceEntry("query", "supported", "supported", {
        requirements: { peers: ["Bearer PEER_SECRET"] },
      }),
      secret: "PEER_SECRET",
    },
    {
      label: "secret-shaped scope",
      entry: evidenceEntry("query", "supported", "supported", {
        authorizationScopes: ["scope:TOKEN_SECRET"],
      }),
      secret: "TOKEN_SECRET",
    },
    {
      label: "nested credential extension",
      entry: evidenceEntry("query", "supported", "supported", {
        constraints: {
          extensions: {
            "com.example.metadata": { accessToken: "EXTENSION_SECRET" },
          },
        },
      }),
      secret: "EXTENSION_SECRET",
    },
    {
      label: "namespaced credential extension key",
      entry: evidenceEntry("query", "supported", "supported", {
        constraints: {
          extensions: {
            "com.example.apiKey": "NAMESPACED_EXTENSION_SENTINEL",
          },
        },
      }),
      secret: "NAMESPACED_EXTENSION_SENTINEL",
    },
    {
      label: "credential extension key segment",
      entry: evidenceEntry("query", "supported", "supported", {
        constraints: {
          extensions: {
            "com.authorization.metadata": "SEGMENT_EXTENSION_SENTINEL",
          },
        },
      }),
      secret: "SEGMENT_EXTENSION_SENTINEL",
    },
    {
      label: "prototype-shaped extension key",
      entry: evidenceEntry("query", "supported", "supported", {
        constraints: {
          extensions: JSON.parse('{"com.example.metadata":{"__proto__":{"sentinel":"PROTOTYPE_SENTINEL"}}}') as never,
        },
      }),
      secret: "PROTOTYPE_SENTINEL",
    },
    {
      label: "caller-sensitive invalid extension key",
      entry: evidenceEntry("query", "supported", "supported", {
        constraints: {
          extensions: { EXTENSION_KEY_SECRET: "ordinary-metadata" } as never,
        },
      }),
      secret: "EXTENSION_KEY_SECRET",
    },
  ])("rejects $label without echoing its value", ({ entry, secret }) => {
    let error: unknown;
    try {
      createCapabilityEvidenceProfile([entry]);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(secret);
  });

  it.each([
    "authorizationHeader",
    "authorization_header",
    "accessTokenValue",
    "access-token-value",
    "signedUrlValue",
    "signed_URL_value",
    "privateKeyPem",
    "private-key-pem",
    "authToken",
    "auth_token",
    "apiKeyValue",
    "api_key_value",
    "clientSecretValue",
    "refreshTokenValue",
    "proxyAuthorizationHeader",
  ])("rejects credential key tokenization variant %s without key/value echo", (key) => {
    const sentinel = `CREDENTIAL_VALUE_${key}`;
    const entry = evidenceEntry("query", "supported", "supported", {
      constraints: {
        extensions: {
          "com.example.metadata": { [key]: sentinel },
        },
      },
    });
    let error: unknown;
    try {
      createCapabilityEvidenceProfile([entry]);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/credential-sensitive extension key/);
    expect(String(error)).not.toContain(key);
    expect(String(error)).not.toContain(sentinel);
  });

  it("keeps non-credential camel-case extension metadata available", () => {
    const profile = createCapabilityEvidenceProfile([
      evidenceEntry("query", "supported", "supported", {
        constraints: {
          extensions: {
            "com.example.metadata": {
              accessibilityMode: "enhanced",
              apiVersionValue: 2,
              privateMetadataEnabled: false,
              signedCount: 3,
            },
          },
        },
      }),
    ]);
    expect(profile.entries[0]?.constraints?.extensions).toMatchObject({
      "com.example.metadata": { accessibilityMode: "enhanced", apiVersionValue: 2 },
    });
  });

  it("rejects credential-named extension keys at the transport boundary without echoing caller content", () => {
    const valid = createCapabilityEvidenceProfile([
      evidenceEntry("query", "supported", "supported", {
        constraints: { extensions: { "com.example.metadata": { enabled: true } } },
      }),
    ]);
    const transported = JSON.parse(serializeCapabilityEvidenceProfile(valid)) as {
      entries: Array<{ constraints: { extensions: Record<string, unknown> } }>;
    };
    transported.entries[0]!.constraints.extensions = {
      "com.example.apiKey": { "metadata.authorization": "TRANSPORT_EXTENSION_SENTINEL" },
    };

    let error: unknown;
    try {
      parseCapabilityEvidenceProfile(transported);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/credential-sensitive extension key/);
    expect(String(error)).not.toContain("apiKey");
    expect(String(error)).not.toContain("TRANSPORT_EXTENSION_SENTINEL");
  });

  it("applies structural peer and scope validation to dynamic context", () => {
    const profile = createCapabilityEvidenceProfile([evidenceEntry("query")]);
    expect(() =>
      evaluateCapabilityProfile(profile, {
        availablePeers: ["Bearer PEER_SECRET"],
      }),
    ).toThrow(/structural package or runtime peer identifier/);
    expect(() =>
      evaluateCapabilityProfile(profile, {
        authorization: { grantedScopes: ["scope:TOKEN_SECRET"] },
      }),
    ).toThrow(/credential-shaped data/);
  });

  it("preserves accepted caller data exactly and documents that serialization is not sanitization", () => {
    const profile = createCapabilityEvidenceProfile([
      evidenceEntry("query", "supported", "supported", {
        evidence: [
          {
            kind: "protocol-default",
            truth: "supported",
            reference: "tenant-metadata:internal-record-123",
            sourceFingerprint: SCHEMA_FINGERPRINT,
          },
          evidenceEntry("query").evidence[1]!,
        ],
      }),
    ]);
    expect(serializeCapabilityEvidenceProfile(profile)).toContain("tenant-metadata:internal-record-123");

    const guide = readFileSync(new URL("../docs/source-capabilities.md", import.meta.url), "utf8");
    expect(guide).toMatch(/potentially sensitive/i);
    expect(guide).toMatch(/does not sanitize/i);
  });

  it("round-trips a near-maximum static profile after evaluated transport grows beyond 2 MiB", () => {
    const entries = Array.from(
      { length: 256 },
      (_, index): CapabilityEvaluationEntry => ({
        id: `com.example.cap${index}`,
        claimed: "supported",
        observed: "not-observed",
        evidence: [{ kind: "protocol-default", truth: "supported", reference: `adapter:cap${index}` }],
        constraints: { extensions: { "com.example.payload": "x".repeat(7_920) } },
      }),
    );
    const evidenceProfile = createCapabilityEvidenceProfile(entries, { sourceFingerprint: SCHEMA_FINGERPRINT });
    const evidenceWire = serializeCapabilityEvidenceProfile(evidenceProfile);
    const evidenceWireBytes = new TextEncoder().encode(evidenceWire).byteLength;
    expect(evidenceWireBytes).toBeGreaterThan(2_000_000);
    expect(evidenceWireBytes).toBeLessThanOrEqual(CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.bytes);
    expect(
      parseCapabilityEvidenceProfile(evidenceWire, {
        expectedSourceFingerprint: SCHEMA_FINGERPRINT,
        expectedSourceEndpoint: SOURCE_ENDPOINT,
      }),
    ).toEqual(evidenceProfile);

    const evaluatedWire = serializeCapabilityProfile(evaluateCapabilityProfile(evidenceProfile));
    expect(new TextEncoder().encode(evaluatedWire).byteLength).toBeGreaterThan(2 * 1_024 * 1_024);
    expect(
      parseCapabilityProfile(evaluatedWire, {
        expectedSourceFingerprint: SCHEMA_FINGERPRINT,
        expectedSourceEndpoint: SOURCE_ENDPOINT,
      }),
    ).toEqual(evaluateCapabilityProfile(evidenceProfile));
  });

  it("keeps static and evaluated transport limits distinct and rejects just-over-limit inputs", () => {
    expect(() => parseCapabilityEvidenceProfile(" ".repeat(CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.bytes + 1))).toThrow(
      new RegExp(`${CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.bytes} byte limit`),
    );
    const staticNodeOverflow = JSON.stringify(
      Array.from({ length: CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.nodes }, () => null),
    );
    expect(() => parseCapabilityEvidenceProfile(staticNodeOverflow)).toThrow(
      new RegExp(`${CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.nodes} node limit`),
    );

    expect(() => parseCapabilityProfile(" ".repeat(CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS.bytes + 1))).toThrow(
      new RegExp(`${CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS.bytes} byte limit`),
    );
    const nodeOverflow = JSON.stringify(
      Array.from({ length: CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS.nodes }, () => null),
    );
    expect(() => parseCapabilityProfile(nodeOverflow)).toThrow(
      new RegExp(`${CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS.nodes} node limit`),
    );
  });
});
