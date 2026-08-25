import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CorpusDocument,
  excerptFor,
  execute,
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
  process.env.HONUA_DOCS_CORPUS_PATH = undefined;
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

  it("validates its input", () => {
    expect(() => schema.parse({ query: "a" })).toThrow();
    expect(() => schema.parse({ query: "capability", limit: 99 })).toThrow();
  });
});
