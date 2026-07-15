import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
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

export interface CrossSdkSourceTreeRefreshReport {
  readonly schemaVersion: 1;
  readonly outcome: "updated" | "unchanged";
  readonly previousGitTree: string;
  readonly gitTree: string;
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
const MAX_CORPUS_BYTES = 1_048_576;
const MAX_INPUT_NODES = 20_000;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_STRING = 8_192;
const MAX_INPUT_STRING_TOTAL = 524_288;
const DEFAULT_CORPUS_PATH = "bench/cross-sdk/corpus.json";

/**
 * Inspect the committed Honua source tree without validating the corpus pin.
 *
 * This deliberately does not read the corpus or legal-review evidence. A stale
 * pin is the reason this maintenance path exists, and inspection must remain
 * offline and usable while the normal validator fails closed.
 */
export function inspectCrossSdkSourceTree(corpusPath = DEFAULT_CORPUS_PATH): string {
  const root = path.resolve(path.dirname(corpusPath), "../..");
  const gitTree = execFileSync("git", ["rev-parse", "HEAD:src"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(gitTree)) fail("HEAD:src did not resolve to a 40-character Git tree");
  return gitTree;
}

/**
 * Replace only the Honua source-tree pin while preserving every other byte in
 * the corpus. Full fixture, package, license, and terms validation remains a
 * separate fail-closed step after this bounded recovery action.
 */
export async function refreshCrossSdkSourceTree(
  corpusPath = DEFAULT_CORPUS_PATH,
): Promise<CrossSdkSourceTreeRefreshReport> {
  const bytes = await readFile(corpusPath);
  if (bytes.byteLength > MAX_CORPUS_BYTES) fail("corpus file exceeds the byte limit");
  const source = bytes.toString("utf8");
  let foreign: unknown;
  try {
    foreign = JSON.parse(source);
  } catch {
    fail("corpus JSON could not be parsed");
  }
  const corpus = validateCrossSdkReferenceCorpusForMaintenance(foreign);
  const honua = corpus.references.find(({ id }) => id === "honua-sdk-js");
  const previousGitTree = honua?.package?.sourceTree?.gitTree;
  if (!previousGitTree) fail("Honua source tree binding is missing");

  const gitTree = inspectCrossSdkSourceTree(corpusPath);
  if (gitTree === previousGitTree) {
    return Object.freeze({ schemaVersion: 1, outcome: "unchanged", previousGitTree, gitTree });
  }

  const quotedPrevious = JSON.stringify(previousGitTree);
  const valueOffset = source.indexOf(quotedPrevious);
  if (valueOffset < 0 || source.indexOf(quotedPrevious, valueOffset + quotedPrevious.length) >= 0)
    fail("Honua source tree pin is not uniquely addressable");
  const updated = `${source.slice(0, valueOffset)}${JSON.stringify(gitTree)}${source.slice(
    valueOffset + quotedPrevious.length,
  )}`;

  const expected = foreign as {
    references: Array<{ id: string; package: null | { sourceTree?: { gitTree: string } } }>;
  };
  const expectedHonua = expected.references.find(({ id }) => id === "honua-sdk-js");
  if (!expectedHonua?.package?.sourceTree) fail("Honua source tree binding is missing");
  expectedHonua.package.sourceTree.gitTree = gitTree;
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(updated);
  } catch {
    fail("updated corpus JSON could not be parsed");
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(expected)) fail("source-tree refresh changed unrelated corpus data");

  await writeFile(corpusPath, updated, "utf8");
  return Object.freeze({ schemaVersion: 1, outcome: "updated", previousGitTree, gitTree });
}

export function validateCrossSdkReferenceCorpus(foreign: unknown, now = "2026-07-12"): CrossSdkReferenceCorpus {
  try {
    return validateCrossSdkReferenceCorpusUnsafe(foreign, now);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Invalid cross-SDK reference corpus:")) throw cause;
    throw new Error("Invalid cross-SDK reference corpus: input inspection failed", { cause });
  }
}

function validateCrossSdkReferenceCorpusForMaintenance(foreign: unknown): CrossSdkReferenceCorpus {
  try {
    return validateCrossSdkReferenceCorpusUnsafe(foreign, undefined);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Invalid cross-SDK reference corpus:")) throw cause;
    throw new Error("Invalid cross-SDK reference corpus: input inspection failed", { cause });
  }
}

function validateCrossSdkReferenceCorpusUnsafe(foreign: unknown, now: string | undefined): CrossSdkReferenceCorpus {
  const corpus = record(snapshotOwnedData(foreign), "corpus") as unknown as CrossSdkReferenceCorpus;
  exactKeys(
    corpus,
    ["schemaVersion", "id", "reviewedAt", "reviewExpiresAt", "methodology", "fixtures", "tasks", "references"],
    "corpus",
  );
  if (corpus.schemaVersion !== 1 || !SAFE_ID.test(corpus.id)) fail("corpus discriminator is invalid");
  const dates: Array<readonly [label: string, date: string]> = [
    ["reviewedAt", corpus.reviewedAt],
    ["reviewExpiresAt", corpus.reviewExpiresAt],
  ];
  if (now !== undefined) dates.push(["now", now]);
  for (const [label, date] of dates) {
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) fail(`${label} must be an ISO date`);
  }
  if (corpus.reviewedAt > corpus.reviewExpiresAt) fail("license review expires before it was performed");
  if (now !== undefined && now > corpus.reviewExpiresAt) fail("license review evidence is stale");

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

  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length === 0 || corpus.fixtures.length > 16)
    fail("fixtures must be bounded and non-empty");
  if (!Array.isArray(corpus.tasks) || corpus.tasks.length === 0 || corpus.tasks.length > 32)
    fail("tasks must be bounded and non-empty");
  if (!Array.isArray(corpus.references) || corpus.references.length !== REFERENCE_IDS.length)
    fail("all reference states must be explicit");
  if (JSON.stringify(corpus.references.map(({ id }) => id)) !== JSON.stringify(REFERENCE_IDS))
    fail("reference order and identity must match the normative schema");
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
    if (
      !["honua", "esri", "mapbox", "maplibre", "carto", "deck.gl", "cesium"].includes(value.vendor) ||
      !["eligible", "unavailable", "not-comparable"].includes(value.status) ||
      typeof value.product !== "string" ||
      value.product.length === 0
    )
      fail(`${value.id} reference discriminator is invalid`);
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
      !["approved", "review-required"].includes(evidence.decision) ||
      !["permitted-under-open-source-license", "not-cleared"].includes(evidence.publication) ||
      typeof evidence.license !== "string" ||
      typeof evidence.notes !== "string"
    )
      fail(`${value.id} license decision is invalid`);
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
      if (
        path.isAbsolute(evidence.licensePath) ||
        evidence.licensePath.split(/[\\/]/).includes("..") ||
        (evidence.licensePath !== "LICENSE" && !evidence.licensePath.startsWith("node_modules/"))
      )
        fail(`${value.id} license path is outside reviewed roots`);
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
  if (bytes.byteLength > MAX_CORPUS_BYTES) fail("corpus file exceeds the byte limit");
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
    const candidate = path.resolve(root, evidence.licensePath);
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`))
      fail(`${reference.id} license path escapes the repository`);
    const licenseBytes = await readFile(realCandidate);
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
  const termsReview = record(
    snapshotOwnedData(JSON.parse(await readFile(path.join(path.dirname(corpusPath), "terms-review.json"), "utf8"))),
    "terms review",
  );
  const reviewedUrls = new Set(
    (termsReview.observations as Array<Record<string, unknown>>)
      .filter(
        ({ reachable, status }) => reachable === true && typeof status === "number" && status >= 200 && status < 400,
      )
      .map(({ url }) => String(url)),
  );
  const requiredUrls = corpus.references
    .filter(({ status }) => status !== "eligible")
    .flatMap(({ licenseEvidence }) =>
      [licenseEvidence.sourceUrl, licenseEvidence.termsUrl].filter((url): url is string => Boolean(url)),
    );
  if (
    termsReview.corpusId !== corpus.id ||
    typeof termsReview.observedAt !== "string" ||
    termsReview.observedAt.slice(0, 10) < corpus.reviewedAt
  )
    fail("restricted terms review artifact is stale or mismatched");
  if (requiredUrls.some((url) => !reviewedUrls.has(url))) fail("restricted terms review is incomplete");
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
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
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

function snapshotOwnedData(foreign: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const budget = { nodes: 0, strings: 0 };
  const visit = (value: unknown, depth: number): unknown => {
    budget.nodes += 1;
    if (budget.nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) fail("input exceeds structural limits");
    if (typeof value === "string") {
      budget.strings += value.length;
      if (value.length > MAX_INPUT_STRING || budget.strings > MAX_INPUT_STRING_TOTAL)
        fail("input strings exceed limits");
      return value;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "object") fail("input must contain JSON data only");
    if (ancestors.has(value)) fail("input is cyclic");
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === "symbol") || keys.length > 257) fail("input properties exceed limits");
      if (Array.isArray(value)) {
        const lengthValue = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
        if (
          typeof lengthValue !== "number" ||
          !Number.isSafeInteger(lengthValue) ||
          lengthValue < 0 ||
          lengthValue > 256 ||
          keys.length !== lengthValue + 1
        )
          fail("input array must be bounded and dense");
        const length = lengthValue;
        return Object.freeze(
          Array.from({ length }, (_, index) => visit(dataDescriptor(value, String(index)), depth + 1)),
        );
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        fail("input records must be plain objects");
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) result[key] = visit(dataDescriptor(value, key), depth + 1);
      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(foreign, 0);
}

function dataDescriptor(value: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (!descriptor || descriptor.get || descriptor.set) fail("input accessors are forbidden");
  return descriptor.value;
}

function fail(message: string): never {
  throw new Error(`Invalid cross-SDK reference corpus: ${message}`);
}

export async function runCrossSdkReferenceCli(
  args: readonly string[],
  writeOutput: (value: string) => void = (value) => {
    process.stdout.write(value);
  },
): Promise<void> {
  const refreshTerms = args.includes("--refresh-terms");
  const printSourceTree = args.includes("--print-source-tree");
  const writeSourceTree = args.includes("--write-source-tree");
  const unknown = args.filter(
    (argument) =>
      argument.startsWith("--") &&
      !["--refresh-terms", "--print-source-tree", "--write-source-tree"].includes(argument),
  );
  if (unknown.length > 0) throw new Error(`Unknown cross-SDK reference option: ${unknown.join(", ")}`);
  if ([refreshTerms, printSourceTree, writeSourceTree].filter(Boolean).length > 1)
    throw new Error("Cross-SDK reference maintenance modes are mutually exclusive");
  const positional = args.filter((argument) => !argument.startsWith("--"));
  const corpus = positional[0] ?? DEFAULT_CORPUS_PATH;
  const output = positional[1];
  if (printSourceTree) {
    writeOutput(`${inspectCrossSdkSourceTree(corpus)}\n`);
    return;
  }
  if (writeSourceTree) {
    writeOutput(`${JSON.stringify(await refreshCrossSdkSourceTree(corpus))}\n`);
    return;
  }
  const report = await validateCrossSdkReferenceFiles(corpus, new Date().toISOString().slice(0, 10));
  const termsRefresh = refreshTerms ? await refreshRestrictedTerms(corpus) : undefined;
  if (output) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify({ ...report, ...(termsRefresh ? { termsRefresh } : {}) }, null, 2)}\n`,
      "utf8",
    );
  }
  writeOutput(
    `Cross-SDK reference corpus valid: ${report.eligibleReferences.length} eligible, ${report.unavailableReferences.length} unavailable/not-comparable; rankings forbidden.\n`,
  );
}

async function main(): Promise<void> {
  await runCrossSdkReferenceCli(process.argv.slice(2));
}

async function refreshRestrictedTerms(corpusPath: string): Promise<unknown> {
  const corpus = validateCrossSdkReferenceCorpus(JSON.parse(await readFile(corpusPath, "utf8")));
  const urls = [
    ...new Set(
      corpus.references
        .filter(({ status }) => status !== "eligible")
        .flatMap(({ licenseEvidence }) =>
          [licenseEvidence.sourceUrl, licenseEvidence.termsUrl].filter((url): url is string => Boolean(url)),
        ),
    ),
  ];
  const observations = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8_000) });
      observations.push({ url, finalUrl: response.url, status: response.status, reachable: response.ok });
    } catch (error) {
      observations.push({
        url,
        finalUrl: null,
        status: null,
        reachable: false,
        error: error instanceof Error ? error.name : "Error",
      });
    }
  }
  return Object.freeze({ observedAt: new Date().toISOString(), boundedTimeoutMs: 8_000, observations });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
