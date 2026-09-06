#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { readSnippetFiles, validateSnippetWithCompiler, validateSnippets } from "./docs-snippets.mjs";
import { readInstalledCandidate, withInstalledCandidate } from "./installed-package-certification.mjs";

const root = path.resolve(import.meta.dirname, "..");
const blocker = "honua-sdk-js#1113";
const knownDefects = new Map([["maplibre-quickstart", "honua-sdk-js#1584"]]);
const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.status === 0 ? "pass" : "fail",
    diagnostic: result.status === 0 ? undefined : (result.stderr || result.stdout).trim().slice(-4_000),
  };
}

async function copyDocumentation(packageRoot) {
  await writeFile(path.join(packageRoot, "tsconfig.json"), `${JSON.stringify({ compilerOptions: {
    jsx: "react-jsx", lib: ["ES2022", "ESNext.Disposable", "DOM", "DOM.Iterable"], module: "NodeNext",
    moduleResolution: "NodeNext", strict: true, target: "ES2022", types: ["node", "react", "react-dom"],
    verbatimModuleSyntax: true,
  } }, null, 2)}\n`);
  for (const relative of ["README.md", "INSTALL.md", "docs", "examples", "skills"]) {
    await cp(path.join(root, relative), path.join(packageRoot, relative), { recursive: true, force: true });
  }
}

export async function certifyInstalledExamples({ output = "test-results/installed-example-certification.json" } = {}) {
  const candidate = await readInstalledCandidate();
  return withInstalledCandidate(candidate, async ({ installed, packageRoot }) => {
    await copyDocumentation(packageRoot);
    const examples = [];
    const entries = await readdir(path.join(root, "examples"), { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory() && !["_kit", "shared"].includes(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const config = path.join(root, "examples", entry.name, "vite.config.ts");
      let source;
      try { source = await readFile(config, "utf8"); } catch { source = undefined; }
      if (!source?.includes("createSampleViteConfig")) {
        examples.push({ id: entry.name, kind: "example", verdict: "blocked", blockedBy: blocker,
          diagnostic: source ? "example does not expose the shared installed-package Vite mode" : "example has no executable Vite configuration" });
        continue;
      }
      const observed = execute(path.join(root, "node_modules/.bin/vite"), ["build", "--config", config], {
        cwd: root,
        env: { ...process.env, HONUA_SAMPLE_SDK_MODE: "packed", HONUA_SAMPLE_SDK_DIR: packageRoot },
      });
      examples.push({ id: entry.name, kind: "example", verdict: observed.status,
        ...(observed.status === "fail" && knownDefects.has(entry.name) ? { issue: knownDefects.get(entry.name) } : {}),
        ...(observed.diagnostic ? { diagnostic: observed.diagnostic } : {}) });
    }

    const snippetFiles = readSnippetFiles(root);
    let batchFailure;
    try { validateSnippets({ files: snippetFiles, projectRoot: packageRoot }); } catch (error) { batchFailure = error; }
    const snippets = [];
    for (const file of snippetFiles) {
      for (const snippet of file.snippets) {
        const id = `${snippet.sourcePath}:${snippet.startLine}`;
        if (snippet.directive === "skip") {
          snippets.push({ id, kind: "doc-snippet", verdict: "not-executable", diagnostic: snippet.reason });
          continue;
        }
        const failures = batchFailure ? validateSnippetWithCompiler(snippet, packageRoot) : [];
        snippets.push({ id, kind: "doc-snippet", verdict: failures.length === 0 ? "pass" : "fail",
          ...(failures.length ? { diagnostic: failures.join("\n").slice(0, 4_000) } : {}) });
      }
    }
    const verdicts = [...examples, ...snippets];
    const summary = Object.fromEntries(["pass", "fail", "blocked", "not-executable"].map((verdict) => [verdict, verdicts.filter((row) => row.verdict === verdict).length]));
    const receipt = {
      schema: "honua.sdk-installed-example-certification-receipt/v1",
      generatedAt: new Date().toISOString(),
      release: candidate.release,
      package: { ...candidate.package, resolved: installed.resolved },
      server: candidate.server,
      summary: { total: verdicts.length, examples: examples.length, snippets: snippets.length, ...summary },
      verdict: summary.fail > 0 ? "failed" : summary.blocked > 0 ? "blocked" : "passed",
      verdicts,
    };
    const complete = { ...receipt, receiptDigest: digest(receipt) };
    await mkdir(path.dirname(path.resolve(root, output)), { recursive: true });
    await writeFile(path.resolve(root, output), `${JSON.stringify(complete, null, 2)}\n`);
    return complete;
  }, { consumerDependencies: candidate.consumerDependencies });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf("--output");
  const receipt = await certifyInstalledExamples({ output: outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined });
  console.log(`${receipt.verdict}: ${receipt.summary.pass} pass, ${receipt.summary.fail} fail, ${receipt.summary.blocked} blocked; ${receipt.summary.examples} examples, ${receipt.summary.snippets} snippets`);
  process.exitCode = receipt.summary.fail > 0 ? 1 : 0;
}
