import { describe, expect, it } from "vitest";

import {
  CAPABILITY_PROFILE_KIND,
  CAPABILITY_PROFILE_VERSION,
  type CapabilityEvaluationContext,
  type CapabilityEvaluationEntry,
  evaluateCapabilityProfile,
  serializeCapabilityProfile,
} from "../src/source-capabilities.js";

const SCHEMA_FINGERPRINT = `sha256:${"a".repeat(64)}` as const;
const EVALUATED_AT = "2026-07-14T12:00:00Z";
const EXPIRES_AT = "2026-07-20T12:00:00Z";

function evaluate(entries: readonly CapabilityEvaluationEntry[], context: CapabilityEvaluationContext = {}) {
  return evaluateCapabilityProfile(entries, { evaluatedAt: EVALUATED_AT, ...context });
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

    expect(first.fingerprint).toBe(refreshed.fingerprint);
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
    const withoutClock = evaluateCapabilityProfile([entry]);
    const stale = evaluateCapabilityProfile([entry], { evaluatedAt: "2026-07-21T12:00:00Z" });
    const fresh = evaluateCapabilityProfile([entry], { evaluatedAt: EVALUATED_AT });
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
      evaluateCapabilityProfile([nanosecondWindow], {
        evaluatedAt: "2026-07-14T12:00:00.000000002Z",
      }).entries[0]?.effective,
    ).toBe("supported");
    expect(
      evaluateCapabilityProfile([nanosecondWindow], {
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
      label: "entry",
      key: "cliamed",
      run: () =>
        evaluate([{ ...evidenceEntry("query"), cliamed: "supported" } as unknown as CapabilityEvaluationEntry]),
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
    expect(run).toThrowError(new RegExp(`unknown key ${key}`));
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

    expect(() => evaluateCapabilityProfile([evidenceEntry("query")], context)).toThrow(/accessors are not supported/);
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
    expect(oversizedRun).toThrow(/byte profile limit/);

    let hostileProfile: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 100; index++) hostileProfile = { nested: hostileProfile };
    expect(() => serializeCapabilityProfile(hostileProfile as never)).toThrow(TypeError);
    expect(() => serializeCapabilityProfile(hostileProfile as never)).toThrow(/maximum input graph depth 48/);
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
      message: /duplicate value application\/json/,
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
});
