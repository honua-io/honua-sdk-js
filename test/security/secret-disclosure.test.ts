/**
 * Security eval — **secret disclosure** (honua-sdk-js#1425, AC "Security evals
 * reject … secret disclosure …").
 *
 * The property under test: *nothing an agent reads, emits, persists, or hands
 * to another party can carry credential material.* Four carriers, because those
 * are the four an agent on the 2026.1 terminal journey actually touches:
 *
 * 1. the **skill corpus** it loads verbatim into its own context;
 * 2. the **documentation corpus** the local `honua_docs_search` MCP tool
 *    answers from (the tool's own responses are evaluated in
 *    `mcp/test/security-evals.test.ts`, against this same corpus);
 * 3. the **command receipt** it prints and persists as audit evidence;
 * 4. the **exported map artifact** it hands to another client.
 *
 * Every assertion here is on **serialized bytes**, never on "a sanitizer ran".
 * A guard that is called but returns the input unchanged passes the second kind
 * of test and fails the first, and the first is the one that matters.
 *
 * ## Gaps closed by this suite
 *
 * 1. `HonuaCommandPlan` documents that a plan "carries no request body: command
 *    inputs can contain connection credentials, and a plan is rendered to
 *    terminals and logs" — but `import.create` interpolated its caller-supplied
 *    `sourceUrl` into the plan's `summary`, so a presigned import URL was
 *    recorded verbatim on the receipt that `serializeHonuaCommandReceipt`
 *    exists to persist. `redactPlanSummary` in
 *    `src/control-plane/commands/runtime.ts` now puts the summary through the
 *    SDK's one credential recognizer. "never lets a presigned import URL
 *    survive onto a receipt" below is the regression lock.
 * 2. `isSensitiveExportKey` did not recognize `adminKey` — the property name
 *    this repository's own CLI uses for the root administrator credential.
 *    `api[-_]?key` was enumerated, a bare `key` was deliberately not, and
 *    `adminKey` fell between them. `SENSITIVE_KEY` in
 *    `src/core/credential-redaction.ts` now enumerates the `<qualifier>Key`
 *    family; "refuses the root administrator credential's own property name"
 *    is the lock, and "still exports the ordinary *Key identifiers" pins the
 *    boundary so the fix cannot be widened into `primaryKey`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import {
  HonuaCommandError,
  createHonuaCommandRuntime,
  importCreateCommand,
  serializeHonuaCommandReceipt,
} from "../../src/control-plane/index.js";
import {
  HonuaExportSafetyError,
  assertCredentialFreeExportBytes,
  assertCredentialFreeExportText,
  containsCredentialMaterial,
  extractPrintableRuns,
  isSensitiveExportKey,
  redactHonuaExportText,
  sanitizeHonuaExportHeaders,
  stripCredentialsFromUrl,
} from "../../src/core/credential-redaction.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage, exportMapPackage } from "../../src/runtime/index.js";
import { PLANTED, recorder, recordingClient, utf8Bytes } from "./harness.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Credential shapes that are unambiguous in prose.
 *
 * Deliberately a *narrower* table than `redactHonuaExportText`'s: that scanner
 * also carries a `name: value` heuristic, and English prose legitimately
 * contains "a reference, **not** a password: ...". Documentation is written for
 * humans, so gating it on the loose heuristic would fail on correct security
 * *advice*. These shapes have no innocent reading — a JWT, an AWS access-key
 * id, a provider token, or a PEM block in a document is a leaked credential.
 *
 * `scripts/verify-skills.mjs` runs an equivalent scan over `skills/` as a drift
 * gate; this extends the same property to the documentation corpus an agent
 * retrieves at run time, which that gate does not cover.
 */
const UNAMBIGUOUS_CREDENTIALS: readonly [string, RegExp][] = [
  ["PEM private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/],
  ["Stripe-style provider key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["OpenAI-style provider key", /\bsk-[A-Za-z0-9]{24,}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["inline bearer token", /\bBearer\s+(?!<|\$\{|YOUR|your)[A-Za-z0-9._~+/=-]{20,}/],
  // Documentation legitimately *describes* this shape — `docs/` explains that
  // `https://user:password@host/...` is refused — so the password segment must
  // not be one of the placeholder words a document would use to teach it.
  [
    "URL with embedded userinfo",
    /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/@:]{1,64}:(?!password\b|passwd\b|pass\b|pwd\b|secret\b|token\b|change-?me\b|placeholder\b|example\b|your-|<|\$\{|\*)[^\s/@]{1,64}@/,
  ],
];

function scanForCredentials(text: string, label: string): void {
  for (const [name, pattern] of UNAMBIGUOUS_CREDENTIALS) {
    const hit = pattern.exec(text);
    expect(hit, `${label} contains a ${name}: ${hit?.[0]?.slice(0, 32) ?? ""}`).toBeNull();
  }
}

function skillBodies(): Array<[string, string]> {
  const dir = resolve(repoRoot, "skills");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`skills/${entry.name}/SKILL.md`, readFileSync(resolve(dir, entry.name, "SKILL.md"), "utf8")]);
}

function basePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-1425-security",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    status: "Ready",
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "ogc_features",
        locator: { url: "https://gis.example.test/ogc/collections/parcels" },
        attribution: "City of Example",
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [{ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } }],
    },
    initialView: { center: [-122.4, 37.8], zoom: 11 },
    attribution: [{ text: "City of Example", url: "https://example.test/credits", required: true }],
    provenance: { generatedBy: "honua-cli", generatorVersion: "0.1.0", generatedAt: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  } as HonuaMapPackage;
}

// ───────────────────────────────────────────────────────────────────────────
// Carrier 1 — the skill corpus the agent loads into its own context
// ───────────────────────────────────────────────────────────────────────────

describe("secret disclosure :: skill bodies", () => {
  it("carries no credential material in any release-scoped skill body", () => {
    // Attacker: a working credential pasted into a skill while debugging is
    // then loaded verbatim into every agent context that matches the skill's
    // `description`, and echoed into transcripts, tickets, and model providers.
    // Skills are the highest-fanout text in this repository.
    const bodies = skillBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(10);
    for (const [path, body] of bodies) scanForCredentials(body, path);
  });

  it("teaches secret *reference* rather than secret *value* on every stage that handles one", () => {
    // Confused agent: told to "connect the datasource", it inlines the password
    // it was given into the request body, and the connection record — plus every
    // log and audit row downstream of it — now holds a plaintext credential.
    // The two skills that touch credentials must say so in the body an agent
    // reads, not only in a review comment.
    const byPath = new Map(skillBodies());
    for (const path of ["skills/honua-datasource-connect/SKILL.md", "skills/honua-local-setup/SKILL.md"]) {
      const body = byPath.get(path);
      expect(body, `${path} must exist`).toBeDefined();
      expect(body, `${path} must name the env-reference handoff`).toMatch(/env:[A-Z_<]/);
      expect(body, `${path} must forbid echoing secret material`).toMatch(/never (?:inline|read|echo|print)/i);
    }
  });

  it("keeps the generated skills README credential-free too", () => {
    // The README is generated from the frontmatter and is what a human reviews
    // before trusting the corpus; a leak that survives only there is still a leak.
    scanForCredentials(readFileSync(resolve(repoRoot, "skills/README.md"), "utf8"), "skills/README.md");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Carrier 2 — the documentation corpus honua_docs_search answers from
// ───────────────────────────────────────────────────────────────────────────

describe("secret disclosure :: the local documentation corpus", () => {
  it("carries no credential material anywhere in llms.txt or llms-full.txt", () => {
    // Attacker: `honua_docs_search` returns ranked *excerpts* of this corpus
    // verbatim, so a credential committed into any indexed document becomes a
    // tool response — retrievable by an agent that never opened the file, and
    // pasted into whatever transcript that agent is writing to. Proving the
    // corpus is clean proves every possible excerpt of it is clean, which no
    // per-query test can.
    for (const file of ["llms.txt", "llms-full.txt"]) {
      scanForCredentials(readFileSync(resolve(repoRoot, file), "utf8"), file);
    }
  });

  it("carries no credential material in the terminal journey contract the skills cite", () => {
    scanForCredentials(
      readFileSync(resolve(repoRoot, "mcp/release/zero-to-map/journey.v1.json"), "utf8"),
      "journey.v1.json",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Carrier 3 — command receipts, printed and persisted as audit evidence
// ───────────────────────────────────────────────────────────────────────────

describe("secret disclosure :: command receipts", () => {
  it("never lets a presigned import URL survive onto a receipt", async () => {
    // GAP CLOSED. Attacker/confused agent: imports from a presigned URL — the
    // ordinary way to hand a one-off extract to a server — and the receipt it
    // then persists as audit evidence carries the signature that authorized the
    // read. The URL outlives the request, in a file the caller believes is safe
    // to keep and to attach to a ticket.
    const recording = recordingClient({ apiKey: "caller-scoped-key" }, () => ({ body: { jobId: "job-1" } }));
    const runtime = createHonuaCommandRuntime({ client: recording.client });
    const receipt = await runtime.execute(
      importCreateCommand,
      { sourceKind: "geojson", sourceUrl: PLANTED.signedUrl },
      { transport: "mcp" },
    );

    const serialized = serializeHonuaCommandReceipt(receipt);
    expect(serialized).not.toContain("aBcD3fGh1JkLmN0pQrStUv");
    expect(receipt.plan.summary).not.toContain("aBcD3fGh1JkLmN0pQrStUv");
    assertCredentialFreeExportText(serialized, "command receipt");

    // The redaction is deterministic, so the audit join still works: the same
    // call from another transport produces the same key.
    const second = recordingClient({ apiKey: "caller-scoped-key" }, () => ({ body: { jobId: "job-1" } }));
    const other = await createHonuaCommandRuntime({ client: second.client }).execute(
      importCreateCommand,
      { sourceKind: "geojson", sourceUrl: PLANTED.signedUrl },
      { transport: "cli" },
    );
    expect(other.auditKey).toBe(receipt.auditKey);

    // And the *request* still carries the real URL — the redaction is on the
    // rendered record, not on the work.
    expect(recording.requests[0]?.rawBody).toContain("aBcD3fGh1JkLmN0pQrStUv");
  });

  it("never lets URL-embedded basic-auth credentials survive onto a receipt", async () => {
    // Same carrier, the other common shape: `https://user:password@host/...`
    // pasted out of a legacy connection string.
    const recording = recordingClient({ apiKey: "caller-scoped-key" }, () => ({ body: { jobId: "job-2" } }));
    const receipt = await createHonuaCommandRuntime({ client: recording.client }).execute(
      importCreateCommand,
      { sourceKind: "geojson", sourceUrl: PLANTED.userinfoUrl },
      { transport: "sdk" },
    );
    expect(serializeHonuaCommandReceipt(receipt)).not.toContain("s3cr3t-p4ssw0rd");
  });

  it("keeps the CLI's --json receipt output credential-free on the real publish path", async () => {
    // Attacker: the terminal transcript is the artifact humans and agents both
    // re-read. `honua map publish --json` prints the whole receipt; anything on
    // it is now in scrollback, in CI logs, and in whatever the agent summarises.
    const cli = recorder(() => ({ body: { packageId: "pkg-1", links: { self: "/api/v1/admin/packages/pkg-1" } } }));
    vi.stubGlobal("fetch", cli.fetchFn);
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await run([
        "map",
        "publish",
        "map-ops",
        "--package",
        JSON.stringify(basePackage()),
        "--yes",
        "--json",
        "--base-url",
        "https://example.test",
        "--api-key",
        PLANTED.apiKeyValue,
      ]);
      expect(exitCode).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
    const stdout = printed.join("");
    expect(stdout.length).toBeGreaterThan(0);
    // The credential that authorized the call is never echoed back to the terminal.
    expect(stdout).not.toContain(PLANTED.apiKeyValue);
    assertCredentialFreeExportText(stdout, "honua map publish --json stdout");
  });

  it("keeps the serializable error projection free of the message, cause, and response body", () => {
    // Attacker: gets the SDK to surface a server error whose problem-details
    // `detail` quotes the failing URL — signature and all — and the agent logs
    // `JSON.stringify(error)`. `HonuaCommandError.toJSON` is the projection an
    // agent is meant to log, and it must carry no free text at all.
    const error = new HonuaCommandError("transport", "import.create", `Failed to read ${PLANTED.signedUrl}`, {
      correlationId: "corr-1",
      idempotencyKey: "key-1",
    });
    const projected = JSON.stringify(error.toJSON());
    expect(projected).not.toContain("aBcD3fGh1JkLmN0pQrStUv");
    expect(projected).not.toContain(PLANTED.signedUrl);
    assertCredentialFreeExportText(projected, "HonuaCommandError.toJSON()");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Carrier 4 — the exported artifact handed to another client
// ───────────────────────────────────────────────────────────────────────────

describe("secret disclosure :: exported map artifacts", () => {
  it("emits none of seven planted credential shapes in the serialized export bytes", () => {
    // Attacker: an exported map package is the artifact that *leaves* the
    // trust boundary — mailed, committed, published to a gallery. Every carrier
    // below is a real one: a signed tile URL, basic-auth userinfo, a request
    // header map, a token-named property, and credential text hiding in
    // free-form attribution.
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: {
            url: PLANTED.signedUrl,
            headers: { Authorization: PLANTED.bearer, "X-Api-Key": PLANTED.apiKeyValue },
            apiKey: PLANTED.apiKeyValue,
          },
          attribution: `Feed key ${PLANTED.githubPat}`,
        },
        {
          sourceId: "hydrants",
          protocol: "ogc_features",
          locator: { url: PLANTED.userinfoUrl },
          attribution: "City of Example",
        },
      ],
      attribution: [{ text: `Tiles ${PLANTED.jwt}`, url: PLANTED.signedUrl, required: true }],
    } as Partial<HonuaMapPackage>);

    const envelope = exportMapPackage(pkg, { exportedAt: "2026-01-02T00:00:00.000Z", allowInvalid: true });
    const serialized = JSON.stringify(envelope);

    for (const [name, secret] of Object.entries(PLANTED)) {
      if (name === "adminKey") continue; // not present in this package
      expect(serialized, `${name} survived the export`).not.toContain(secret);
    }
    // Two independent scans of the finished artifact: as text, and as the bytes
    // a consumer would actually read off disk.
    assertCredentialFreeExportText(serialized, "exported artifact");
    assertCredentialFreeExportBytes(utf8Bytes(serialized), "exported artifact bytes");
    // And the withholding is *recorded*, so the export is auditable rather than
    // silently lossy.
    expect(envelope.redactions.length).toBeGreaterThan(0);
  });

  it("refuses rather than cleans when the caller asks to be told", () => {
    // Confused agent: exports a package it does not realise carries a token,
    // ships the cleaned artifact, and never learns that its own source binding
    // is now unusable. `credentials: "reject"` is how a pipeline opts into
    // failing loudly instead.
    const pkg = basePackage({
      sourceBindings: [{ sourceId: "parcels", protocol: "ogc_features", locator: { url: PLANTED.signedUrl } }],
    } as Partial<HonuaMapPackage>);
    expect(() => exportMapPackage(pkg, { credentials: "reject", allowInvalid: true })).toThrow(HonuaExportSafetyError);
  });

  it("catches a credential hidden inside a base64 data: URI, where a text scan cannot see it", () => {
    // Attacker: base64 is not encryption, but it *is* invisible to a text
    // scanner — and the whole-envelope rescan deliberately masks data-URI
    // payloads so icon bytes do not trip the entropy heuristic. If the decoded
    // bytes were not scanned separately, a data URI would be a hole straight
    // through the export pipeline.
    const hidden = Buffer.from(`aws_access_key_id=${PLANTED.awsKeyId}`, "utf8").toString("base64");
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: { url: "https://gis.example.test/ogc/collections/parcels" },
          metadata: { icon: `data:image/png;base64,${hidden}` },
        },
      ],
    } as Partial<HonuaMapPackage>);
    expect(() => exportMapPackage(pkg, { allowInvalid: true })).toThrow(HonuaExportSafetyError);
  });

  it("withholds a percent-encoded data: URI payload it cannot decode, rather than emitting it unscanned", () => {
    // Attacker: `data:text/plain,token%3D...` — a payload the decoder refuses
    // is a payload nothing scans. "Cannot decode" must mean "withhold", never
    // "assume safe".
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: { url: "https://gis.example.test/ogc/collections/parcels" },
          metadata: { icon: "data:text/plain,%E0%A4%A" },
        },
      ],
    } as Partial<HonuaMapPackage>);
    const envelope = exportMapPackage(pkg, { allowInvalid: true });
    expect(JSON.stringify(envelope)).not.toContain("%E0%A4%A");
    expect(envelope.redactions.some((entry) => entry.reason === "unsupported-value")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The recognizer itself — one implementation, and it fails closed
// ───────────────────────────────────────────────────────────────────────────

describe("secret disclosure :: the shared credential recognizer", () => {
  it("recognizes every planted shape on sight, so the carrier evals above are not vacuous", () => {
    // A scanner that recognizes nothing makes every "absent from the bytes"
    // assertion above pass trivially. This is the control.
    for (const name of ["bearer", "jwt", "awsKeyId", "githubPat", "signedUrl", "userinfoUrl"] as const) {
      expect(containsCredentialMaterial(PLANTED[name]), `${name} must be recognized`).toBe(true);
    }
  });

  it("catches an unknown-vendor key by its label and its property name, not by guessing at its shape", () => {
    // The honest limit of shape matching: `hnu_live_…` belongs to no vendor the
    // pattern table knows, and inventing a heuristic wide enough to catch it
    // would redact ordinary identifiers. That is why the recognizer has three
    // layers, and the other two are what actually catch it — the labelled
    // `name=value` scan and the sensitive-property-name refusal that the export
    // pipeline applies to `apiKey`, `Authorization`, and friends.
    expect(containsCredentialMaterial(PLANTED.apiKeyValue)).toBe(false);
    expect(containsCredentialMaterial(`api_key=${PLANTED.apiKeyValue}`)).toBe(true);
    for (const key of ["apiKey", "X-API-KEY", "refresh_token", "sessionCookie", "clientSecret"]) {
      expect(isSensitiveExportKey(key), `${key} must be refused as a property name`).toBe(true);
    }
  });

  it("refuses the root administrator credential's own property name", () => {
    // GAP CLOSED. `adminKey` is the property name this repository's CLI uses
    // for the root administrator credential (`profiles.<name>.adminKey`), and
    // the JSON Pointer `honua-diagnostics` tells agents is forbidden. The
    // export recognizer did not know it: `api[-_]?key` was enumerated and a
    // bare `key` deliberately was not, so `adminKey` fell between them and a
    // config-shaped object carrying one would export its value verbatim.
    for (const key of ["adminKey", "admin_key", "ADMIN-KEY", "accessKey", "masterKey", "rootKey", "signingKey"]) {
      expect(isSensitiveExportKey(key), `${key} must be refused as a property name`).toBe(true);
    }
    expect(containsCredentialMaterial(`adminKey=${PLANTED.adminKey}`)).toBe(true);
    expect(containsCredentialMaterial(`admin_key: ${PLANTED.adminKey}`)).toBe(true);
  });

  it("still exports the ordinary *Key identifiers a real map package depends on", () => {
    // The inverse failure, and the reason the fix above enumerates qualifiers
    // instead of matching a bare `key`: an exporter that withholds a layer's
    // `primaryKey` or a style's sort key is not safer, it is broken — and the
    // publish-layers skill puts `primaryKey` in the body an agent copies.
    for (const key of ["primaryKey", "layerKey", "sortKey", "objectIdKey", "key", "keyField", "geometryColumn"]) {
      expect(isSensitiveExportKey(key), `${key} must remain exportable`).toBe(false);
    }
  });

  it("sees through percent-encoding, so an encoded token is not a bypass", () => {
    // Attacker: `%42earer%20…` reads as harmless text to a naive scanner and as
    // a bearer token to whatever finally decodes it.
    expect(containsCredentialMaterial(encodeURIComponent(PLANTED.bearer))).toBe(true);
    expect(redactHonuaExportText(encodeURIComponent(PLANTED.jwt))).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("finds a credential inside binary bytes that never decode as UTF-8", () => {
    // Attacker: hides the token in a PNG `tEXt` chunk or a ZIP comment, because
    // "binary" reads as "opaque". `strings(1)` disagrees, and so must the scan.
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, ...utf8Bytes(PLANTED.awsKeyId), 0x00, 0xff]);
    expect(extractPrintableRuns(binary)).toContain(PLANTED.awsKeyId);
    expect(() => assertCredentialFreeExportBytes(binary, "binary artifact")).toThrow(HonuaExportSafetyError);
  });

  it("strips signatures and userinfo from a URL while keeping the URL usable", () => {
    // The withheld value must not take the *endpoint* with it: an export that
    // drops the whole URL is safe and useless, and the next agent goes looking
    // for the unredacted copy.
    const signed = stripCredentialsFromUrl(PLANTED.signedUrl);
    expect(signed.url).toContain("tiles.example.test");
    expect(signed.url).not.toContain("aBcD3fGh1JkLmN0pQrStUv");
    const userinfo = stripCredentialsFromUrl(PLANTED.userinfoUrl);
    expect(userinfo.url).not.toContain("s3cr3t-p4ssw0rd");
    expect(userinfo.url).not.toContain("svc-user");
  });

  it("drops a request-header map to an allowlist rather than filtering known-bad names", () => {
    // Attacker: invents a header the denylist has never heard of
    // (`X-Acme-Session`) and rides it out with the export. An allowlist has no
    // such failure mode.
    const { headers, redactions } = sanitizeHonuaExportHeaders({
      Accept: "application/json",
      Authorization: PLANTED.bearer,
      "X-Acme-Session": PLANTED.apiKeyValue,
    });
    expect(JSON.stringify(headers)).not.toContain(PLANTED.bearer);
    expect(JSON.stringify(headers)).not.toContain(PLANTED.apiKeyValue);
    expect(redactions.length).toBeGreaterThan(0);
  });
});
