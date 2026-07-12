import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface CrossSdkReferenceCorpus {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly reviewedAt: string;
  readonly reviewExpiresAt: string;
  readonly methodology: Readonly<Record<string, unknown>>;
  readonly fixtures: readonly ReferenceFixture[];
  readonly tasks: readonly ReferenceTask[];
  readonly references: readonly CrossSdkReference[];
}

interface ReferenceFixture {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly license: string;
  readonly source: string;
  readonly containsProductionData: false;
}

interface ReferenceTask {
  readonly id: string;
  readonly fixtureId: string;
  readonly crs: "EPSG:4326";
  readonly viewport: Readonly<Record<string, unknown>>;
  readonly styleIntent: Readonly<Record<string, unknown>>;
  readonly interaction: Readonly<Record<string, unknown>>;
  readonly visualTolerance: Readonly<Record<string, unknown>>;
  readonly exclusions: readonly string[];
}

interface CrossSdkReference {
  readonly id: string;
  readonly vendor: "honua" | "esri" | "mapbox" | "maplibre" | "carto" | "deck.gl" | "cesium";
  readonly product: string;
  readonly status: "eligible" | "unavailable" | "not-comparable";
  readonly package: null | {
    readonly name: string;
    readonly version: string;
    readonly integrity: string;
    readonly lockfile: string | null;
    readonly sourceTree?: { readonly path: string; readonly gitTree: string };
  };
  readonly licenseEvidence: {
    readonly license: string;
    readonly decision: "approved" | "review-required";
    readonly publication: "permitted-under-open-source-license" | "not-cleared";
    readonly sourceUrl: string;
    readonly termsUrl: string | null;
    readonly retrievedAt: string;
    readonly licensePath: string | null;
    readonly licenseContentSha256: string | null;
    readonly notes: string;
  };
  readonly taskIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface CrossSdkReferenceValidationReport {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly corpusSha256: string;
  readonly valid: boolean;
  readonly crossSdkComparable: false;
  readonly comparisonState: "reference-preflight-only";
  readonly rankingPermitted: false;
  readonly eligibleReferences: readonly string[];
  readonly unavailableReferences: readonly {
    readonly id: string;
    readonly status: string;
    readonly reasons: readonly string[];
  }[];
  readonly scenarios: readonly {
    readonly id: string;
    readonly crossSdkComparable: false;
    readonly state: "not-measured";
    readonly reason: string;
  }[];
}

const REFERENCE_IDS = [
  "honua-sdk-js",
  "maplibre-gl-js",
  "deck-gl",
  "cesium-js",
  "arcgis-maps-sdk-js",
  "mapbox-gl-js",
  "carto-deck-gl",
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9.-]+$/;

export function validateCrossSdkReferenceCorpus(foreign: unknown, now = "2026-07-12"): CrossSdkReferenceCorpus {
  try {
    return validateCrossSdkReferenceCorpusUnsafe(foreign, now);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Invalid cross-SDK reference corpus:")) throw cause;
    throw new Error("Invalid cross-SDK reference corpus: input inspection failed", { cause });
  }
}

function validateCrossSdkReferenceCorpusUnsafe(foreign: unknown, now: string): CrossSdkReferenceCorpus {
  const corpus = record(foreign, "corpus") as unknown as CrossSdkReferenceCorpus;
  exactKeys(
    corpus,
    ["schemaVersion", "id", "reviewedAt", "reviewExpiresAt", "methodology", "fixtures", "tasks", "references"],
    "corpus",
  );
  if (corpus.schemaVersion !== 1 || !SAFE_ID.test(corpus.id)) fail("corpus discriminator is invalid");
  for (const [label, date] of [
    ["reviewedAt", corpus.reviewedAt],
    ["reviewExpiresAt", corpus.reviewExpiresAt],
    ["now", now],
  ] as const) {
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) fail(`${label} must be an ISO date`);
  }
  if (corpus.reviewedAt > corpus.reviewExpiresAt) fail("license review expires before it was performed");
  if (now > corpus.reviewExpiresAt) fail("license review evidence is stale");

  const methodology = record(corpus.methodology, "methodology");
  exactKeys(
    methodology,
    [
      "runner",
      "network",
      "cacheStates",
      "warmupRuns",
      "measurementRuns",
      "statistics",
      "completionSignals",
      "rankingPolicy",
    ],
    "methodology",
  );
  if (methodology.network !== "loopback-only" || methodology.rankingPolicy !== "forbidden-until-reviewed-result-set")
    fail("methodology must fail closed");
  if (
    JSON.stringify(methodology.cacheStates) !== '["cold","warm"]' ||
    JSON.stringify(methodology.statistics) !== '["median","p95","coefficient-of-variation"]'
  )
    fail("cache/statistics protocol is invalid");
  if (
    !positiveInteger(methodology.warmupRuns) ||
    !positiveInteger(methodology.measurementRuns) ||
    (methodology.measurementRuns as number) < 3
  )
    fail("warmup/repetition protocol is invalid");
  stringArray(methodology.completionSignals, "completionSignals", 2);

  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length === 0) fail("fixtures must be non-empty");
  if (!Array.isArray(corpus.tasks) || corpus.tasks.length === 0) fail("tasks must be non-empty");
  if (!Array.isArray(corpus.references) || corpus.references.length !== REFERENCE_IDS.length)
    fail("all reference states must be explicit");
  const fixtureIds = new Set<string>();
  for (const fixture of corpus.fixtures) {
    const value = record(fixture, "fixture") as unknown as ReferenceFixture;
    exactKeys(
      value,
      ["id", "path", "sha256", "mediaType", "license", "source", "containsProductionData"],
      `fixture ${value.id}`,
    );
    if (!SAFE_ID.test(value.id) || fixtureIds.has(value.id) || !SHA256.test(value.sha256))
      fail("fixture identity/digest is invalid");
    if (
      !value.path.startsWith("bench/cross-sdk/fixtures/") ||
      value.path.includes("..") ||
      value.containsProductionData !== false
    )
      fail("fixture provenance is unsafe");
    fixtureIds.add(value.id);
  }
  const taskIds = new Set<string>();
  for (const task of corpus.tasks) {
    const value = record(task, "task") as unknown as ReferenceTask;
    exactKeys(
      value,
      ["id", "fixtureId", "crs", "viewport", "styleIntent", "interaction", "visualTolerance", "exclusions"],
      `task ${value.id}`,
    );
    if (
      !SAFE_ID.test(value.id) ||
      taskIds.has(value.id) ||
      !fixtureIds.has(value.fixtureId) ||
      value.crs !== "EPSG:4326"
    )
      fail("task identity/input is invalid");
    for (const key of ["viewport", "styleIntent", "interaction", "visualTolerance"] as const)
      record(value[key], `task.${key}`);
    stringArray(value.exclusions, "task.exclusions", 1);
    taskIds.add(value.id);
  }

  const seen = new Set<string>();
  for (const reference of corpus.references) {
    const value = record(reference, "reference") as unknown as CrossSdkReference;
    exactKeys(
      value,
      ["id", "vendor", "product", "status", "package", "licenseEvidence", "taskIds", "reasons"],
      `reference ${value.id}`,
    );
    if (!REFERENCE_IDS.includes(value.id) || seen.has(value.id)) fail("reference identity is missing or duplicated");
    seen.add(value.id);
    const evidence = record(
      value.licenseEvidence,
      "licenseEvidence",
    ) as unknown as CrossSdkReference["licenseEvidence"];
    exactKeys(
      evidence,
      [
        "license",
        "decision",
        "publication",
        "sourceUrl",
        "termsUrl",
        "retrievedAt",
        "licensePath",
        "licenseContentSha256",
        "notes",
      ],
      `${value.id}.licenseEvidence`,
    );
    if (
      !evidence.sourceUrl.startsWith("https://") ||
      !ISO_DATE.test(evidence.retrievedAt) ||
      evidence.retrievedAt > corpus.reviewedAt
    )
      fail(`${value.id} evidence is invalid`);
    stringArray(value.taskIds, `${value.id}.taskIds`, 0);
    stringArray(value.reasons, `${value.id}.reasons`, 0);
    if (value.taskIds.some((id) => !taskIds.has(id))) fail(`${value.id} references an unknown task`);
    if (value.status === "eligible") {
      if (
        !value.package ||
        evidence.decision !== "approved" ||
        evidence.publication !== "permitted-under-open-source-license" ||
        value.taskIds.length === 0 ||
        value.reasons.length !== 0
      )
        fail(`${value.id} is not eligible`);
      validatePackage(value.package, value.id);
      if (!evidence.licensePath || !evidence.licenseContentSha256 || !SHA256.test(evidence.licenseContentSha256))
        fail(`${value.id} license content is not pinned`);
    } else if (value.taskIds.length !== 0 || value.reasons.length === 0) {
      fail(`${value.id} unavailable state must be explicit and task-free`);
    }
  }
  if (seen.size !== REFERENCE_IDS.length) fail("reference coverage is incomplete");
  rejectCredentialFields(corpus);
  return structuredClone(corpus);
}

export async function validateCrossSdkReferenceFiles(
  corpusPath: string,
  now = "2026-07-12",
): Promise<CrossSdkReferenceValidationReport> {
  const bytes = await readFile(corpusPath);
  const corpus = validateCrossSdkReferenceCorpus(JSON.parse(bytes.toString("utf8")), now);
  const root = path.resolve(path.dirname(corpusPath), "../..");
  for (const fixture of corpus.fixtures) {
    const fixtureBytes = await readFile(path.resolve(root, fixture.path));
    if (createHash("sha256").update(fixtureBytes).digest("hex") !== fixture.sha256)
      fail(`fixture digest mismatch: ${fixture.id}`);
  }
  const lock = JSON.parse(await readFile(path.resolve(root, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string; integrity?: string }>;
  };
  for (const reference of corpus.references.filter(({ status }) => status === "eligible")) {
    if (!reference.package) fail(`${reference.id} package is missing`);
    const locked =
      reference.package.name === "@honua/sdk-js"
        ? lock.packages?.[""]
        : lock.packages?.[`node_modules/${reference.package.name}`];
    if (locked?.version !== reference.package.version) fail(`${reference.id} lockfile version mismatch`);
    if (reference.package.integrity !== "workspace:git-tree" && locked?.integrity !== reference.package.integrity)
      fail(`${reference.id} lockfile integrity mismatch`);
    const evidence = reference.licenseEvidence;
    if (!evidence.licensePath || !evidence.licenseContentSha256) fail(`${reference.id} license digest is missing`);
    const licenseBytes = await readFile(path.resolve(root, evidence.licensePath));
    if (createHash("sha256").update(licenseBytes).digest("hex") !== evidence.licenseContentSha256)
      fail(`${reference.id} license content digest mismatch`);
    if (reference.package.sourceTree) {
      const actual = execFileSync("git", ["rev-parse", `HEAD:${reference.package.sourceTree.path}`], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      if (actual !== reference.package.sourceTree.gitTree) fail(`${reference.id} source tree revision mismatch`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    corpusId: corpus.id,
    corpusSha256: createHash("sha256").update(bytes).digest("hex"),
    valid: true,
    crossSdkComparable: false,
    comparisonState: "reference-preflight-only",
    rankingPermitted: false,
    eligibleReferences: Object.freeze(
      corpus.references
        .filter(({ status }) => status === "eligible")
        .map(({ id }) => id)
        .sort(),
    ),
    unavailableReferences: Object.freeze(
      corpus.references
        .filter(({ status }) => status !== "eligible")
        .map(({ id, status, reasons }) => Object.freeze({ id, status, reasons: Object.freeze([...reasons]) })),
    ),
    scenarios: Object.freeze(
      corpus.tasks.map(({ id }) =>
        Object.freeze({
          id,
          crossSdkComparable: false as const,
          state: "not-measured" as const,
          reason: "No same-run reviewed measurement artifact is present; ranking remains forbidden.",
        }),
      ),
    ),
  });
}

function validatePackage(value: CrossSdkReference["package"] & {}, label: string): void {
  exactKeys(
    value,
    value.sourceTree
      ? ["name", "version", "integrity", "lockfile", "sourceTree"]
      : ["name", "version", "integrity", "lockfile"],
    `${label}.package`,
  );
  if (
    !value.name ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(value.version) ||
    (!value.integrity.startsWith("sha512-") && value.integrity !== "workspace:git-tree") ||
    value.lockfile !== "package-lock.json"
  )
    fail(`${label} package is not reproducibly locked`);
  if (value.sourceTree) {
    exactKeys(value.sourceTree, ["path", "gitTree"], `${label}.package.sourceTree`);
    if (value.sourceTree.path !== "src" || !/^[a-f0-9]{40}$/.test(value.sourceTree.gitTree))
      fail(`${label} source tree binding is invalid`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  let valid = false;
  try {
    valid =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    fail(`${label} could not be inspected`);
  }
  if (!valid) fail(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  let actual: string[];
  try {
    actual = Object.keys(value).sort();
  } catch {
    fail(`${label} keys could not be inspected`);
  }
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} has unknown or missing properties`);
}

function stringArray(value: unknown, label: string, minimum: number): asserts value is string[] {
  let valid = false;
  try {
    valid =
      Array.isArray(value) &&
      value.length >= minimum &&
      value.length <= 64 &&
      value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512);
  } catch {
    fail(`${label} could not be inspected`);
  }
  if (!valid) fail(`${label} is invalid`);
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function rejectCredentialFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectCredentialFields);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(token|apiKey|secret|password|authorization)$/i.test(key)) fail("credential material is forbidden");
    rejectCredentialFields(item);
  }
}

function fail(message: string): never {
  throw new Error(`Invalid cross-SDK reference corpus: ${message}`);
}

async function main(): Promise<void> {
  const corpus = process.argv[2] ?? "bench/cross-sdk/corpus.json";
  const output = process.argv[3];
  const report = await validateCrossSdkReferenceFiles(corpus, new Date().toISOString().slice(0, 10));
  if (output) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(
    `Cross-SDK reference corpus valid: ${report.eligibleReferences.length} eligible, ${report.unavailableReferences.length} unavailable/not-comparable; rankings forbidden.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
