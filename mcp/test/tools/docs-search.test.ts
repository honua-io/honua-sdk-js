import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CorpusDocument,
  excerptFor,
  execute,
  queryTermsOf,
  resolveCorpusRevision,
  resolveDocsCorpus,
  resolveDocsRoot,
  resolveDocsVersion,
  schema,
  scoreDocument,
  splitCorpus,
} from "../../src/tools/docs-search.js";

const CORPUS = [
  "# @honua/sdk-js — full documentation corpus",
  "",
  "---",
  "",
  "# File: docs/errors.md",
  "",
  "# Error handling",
  "",
  "Capability misses throw HonuaCapabilityNotSupportedError rather than returning",
  "empty data. Narrow the query or drop the unsupported clause.",
  "",
  "---",
  "",
  "# File: docs/quickstart.md",
  "",
  "# Five-minute quickstart",
  "",
  "Create a HonuaClient and query a public FeatureServer.",
  "",
].join("\n");

const created: string[] = [];

function fixtureRoot(options: { versions?: unknown; version?: string; manifestVersion?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-docs-search-"));
  created.push(root);
  fs.writeFileSync(path.join(root, "llms-full.txt"), CORPUS);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: options.version ?? "1.2.3-beta.0" }));
  fs.writeFileSync(
    path.join(root, ".release-please-manifest.json"),
    JSON.stringify({ ".": options.manifestVersion ?? options.version ?? "1.2.3-beta.0" }),
  );
  if (options.versions !== undefined) {
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "versions.json"), JSON.stringify(options.versions));
  }
  return root;
}

async function run(root: string, input: unknown) {
  process.env.HONUA_DOCS_CORPUS_PATH = path.join(root, "llms-full.txt");
  const result = await execute(undefined, schema.parse(input));
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  delete process.env.HONUA_DOCS_CORPUS_PATH;
  delete process.env.HONUA_SOURCE_REVISION;
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("honua_docs_search", () => {
  it("splits the corpus on its File headers", () => {
    const documents = splitCorpus(CORPUS);
    expect(documents.map((document) => document.file)).toEqual(["docs/errors.md", "docs/quickstart.md"]);
    expect(documents[0].title).toBe("Error handling");
    expect(documents[0].body).not.toContain("# File:");
  });

  it("cites the source file and the release version", async () => {
    const payload = await run(fixtureRoot(), { query: "capability error" });

    expect(payload.available).toBe(true);
    expect(payload.release).toMatchObject({
      package: "@honua/sdk-js",
      version: "1.2.3-beta.0",
      channel: "beta",
      policy: "docs/documentation-versions.md",
    });
    expect(payload.results[0].citation).toMatchObject({
      file: "docs/errors.md",
      version: "1.2.3-beta.0",
      url: "https://github.com/honua-io/honua-sdk-js/blob/trunk/docs/errors.md",
    });
    expect(payload.results[0].excerpt).toContain("HonuaCapabilityNotSupportedError");
  });

  it("prefers the generated docs/versions.json release when present", () => {
    const root = fixtureRoot({ versions: { package: "@honua/sdk-js", latestRelease: "9.9.9" } });
    expect(resolveDocsVersion(root)).toMatchObject({ version: "9.9.9", channel: "stable" });
  });

  it("restricts results with pathPrefix", async () => {
    const root = fixtureRoot();
    const all = await run(root, { query: "query", limit: 10 });
    const scoped = await run(root, { query: "query", limit: 10, pathPrefix: "docs/quickstart" });

    expect(all.results.length).toBeGreaterThan(1);
    expect(scoped.results.map((result: { citation: { file: string } }) => result.citation.file)).toEqual([
      "docs/quickstart.md",
    ]);
  });

  it("returns an empty, explained result rather than a wrong document", async () => {
    const payload = await run(fixtureRoot(), { query: "kubernetes ingress" });

    expect(payload.available).toBe(true);
    expect(payload.results).toEqual([]);
    expect(payload.guidance).toContain("No indexed document matched");
  });

  it("degrades structurally when the corpus is absent", async () => {
    process.env.HONUA_DOCS_CORPUS_PATH = path.join(os.tmpdir(), "honua-missing-corpus", "llms-full.txt");
    const result = await execute(undefined, schema.parse({ query: "anything" }));
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ available: false, surface: "Honua documentation corpus" });
    expect(payload.guidance).toContain("npm run docs:llms");
  });

  it("refuses to cite a release when package version and manifest disagree", async () => {
    const root = fixtureRoot({ version: "1.2.3", manifestVersion: "1.2.4" });
    const payload = await run(root, { query: "capability" });

    expect(payload).toMatchObject({ available: false, surface: "Honua documentation versions" });
  });

  it("ranks path and heading matches above incidental body matches", () => {
    const quickstart: CorpusDocument = { file: "docs/quickstart.md", title: "Quickstart", body: "# Quickstart\nbody" };
    const other: CorpusDocument = { file: "docs/other.md", title: "Other", body: "mentions quickstart once" };
    expect(scoreDocument(quickstart, ["quickstart"])).toBeGreaterThan(scoreDocument(other, ["quickstart"]));
  });

  it("centers the excerpt on the best matching line", () => {
    const document: CorpusDocument = {
      file: "docs/long.md",
      title: "Long",
      body: [...Array.from({ length: 40 }, (_, index) => `filler ${index}`), "the needle lives here", "after"].join(
        "\n",
      ),
    };
    expect(excerptFor(document, ["needle"])).toContain("the needle lives here");
    expect(excerptFor(document, ["needle"])).not.toContain("filler 0");
  });

  it("resolves the docs root by walking up from the module", () => {
    // The repository checkout that holds this test also holds the committed corpus.
    process.env.HONUA_DOCS_CORPUS_PATH = undefined;
    const root = resolveDocsRoot({});
    expect(root).toBeDefined();
    expect(fs.existsSync(path.join(root as string, "llms-full.txt"))).toBe(true);
  });

  it("drops stopwords so a natural-language question ranks on its meaningful terms", () => {
    // The schema's own example query. Every document contains "how" and "do",
    // so they matched everywhere, added frequency weight everywhere, and
    // inflated the matched-term multiplier everywhere.
    expect(queryTermsOf("how do I handle a capability error")).toEqual(["handle", "capability", "error"]);
    // A query with nothing but stopwords keeps its tokens rather than matching
    // nothing at all.
    expect(queryTermsOf("how do I")).toEqual(["how", "do"]);
  });

  it("returns the dedicated error guide for the schema's example question", () => {
    // Against the committed corpus this query previously ranked docs/guide.md,
    // docs/protocol-capability-matrix.md and docs/offline-regions.md above
    // docs/errors.md, so the default three results omitted it entirely.
    const root = resolveDocsRoot({});
    expect(root).toBeDefined();
    const documents = splitCorpus(fs.readFileSync(path.join(root as string, "llms-full.txt"), "utf8"));
    const terms = queryTermsOf("how do I handle a capability error");
    const ranked = documents
      .map((document) => ({ file: document.file, score: scoreDocument(document, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, 3)
      .map((entry) => entry.file);

    expect(ranked).toContain("docs/errors.md");
  });

  it("reads the corpus the configured path names, whatever it is called", async () => {
    // HONUA_DOCS_CORPUS_PATH documents a path to the corpus file itself. Using
    // only its parent directory read <parent>/llms-full.txt instead: ENOENT for
    // a corpus under another name, or a silent answer from a different file.
    const root = fixtureRoot();
    fs.renameSync(path.join(root, "llms-full.txt"), path.join(root, "corpus-snapshot.txt"));
    process.env.HONUA_DOCS_CORPUS_PATH = path.join(root, "corpus-snapshot.txt");

    const located = resolveDocsCorpus(process.env);
    expect(located?.corpusPath).toBe(path.join(root, "corpus-snapshot.txt"));
    expect(located?.root).toBe(root);

    const result = await execute(undefined, schema.parse({ query: "capability error" }));
    const payload = JSON.parse(result.content[0].text);
    expect(payload.available).toBe(true);
    expect(payload.corpus.file).toBe("corpus-snapshot.txt");
    expect(payload.results[0].citation.file).toBe("docs/errors.md");
  });

  it("still accepts a configured directory that holds the corpus", () => {
    const root = fixtureRoot();
    expect(resolveDocsCorpus({ HONUA_DOCS_CORPUS_PATH: root })?.corpusPath).toBe(path.join(root, "llms-full.txt"));
  });

  it("pins citations to the corpus source commit when it can be established", async () => {
    const root = fixtureRoot();
    const revision = "a".repeat(40);
    process.env.HONUA_SOURCE_REVISION = revision;
    const payload = await run(root, { query: "capability error" });

    expect(payload.corpus.sourceRevision).toBe(revision);
    expect(payload.results[0].citation).toMatchObject({
      sourceRevision: revision,
      url: `https://github.com/honua-io/honua-sdk-js/blob/${revision}/docs/errors.md`,
    });
  });

  it("reports a floating citation rather than a false pin when no commit is known", async () => {
    // A tmpdir fixture is in no checkout, so nothing can vouch for these bytes.
    const root = fixtureRoot();
    const payload = await run(root, { query: "capability error" });

    expect(payload.corpus.sourceRevision).toBeNull();
    expect(payload.results[0].citation).toMatchObject({
      sourceRevision: null,
      url: "https://github.com/honua-io/honua-sdk-js/blob/trunk/docs/errors.md",
    });
  });

  it("pins a committed corpus to HEAD and refuses to pin a modified one", () => {
    // A locally regenerated llms-full.txt is at no commit, so pinning it to
    // HEAD would produce a citation that looks exact and points at other text.
    // Uses a throwaway repository so the result does not depend on whether the
    // developer's own checkout happens to be clean.
    const root = fixtureRoot();
    const corpus = path.join(root, "llms-full.txt");
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    run(["init", "--quiet", "--initial-branch", "trunk"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["add", "."]);
    run(["commit", "--quiet", "-m", "corpus"]);

    const head = resolveCorpusRevision(root, corpus, {});
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    fs.appendFileSync(corpus, "\n# File: docs/not-committed.md\n\nlocal edit\n");
    expect(resolveCorpusRevision(root, corpus, {})).toBeUndefined();
  });

  it("validates its input", () => {
    expect(() => schema.parse({ query: "a" })).toThrow();
    expect(() => schema.parse({ query: "capability", limit: 99 })).toThrow();
  });
});
