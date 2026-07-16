import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = path.join(root, "examples/maplibre-quickstart");
const distRoot = path.join(exampleRoot, "dist");
const budgetPath = path.join(exampleRoot, "budgets.v1.json");
const MAX_BUDGET_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(`First Map budget verification failed: ${message}`);
}

function boundedJson(file, maximumBytes) {
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    fail(`${path.relative(root, file)} is not a bounded regular file`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
  return value;
}

function bundleFiles(directory, maximumFiles) {
  const pending = [directory];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail(`${path.relative(root, absolute)} must not be a symbolic link`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) {
        if (metadata.size > MAX_FILE_BYTES) fail(`${path.relative(root, absolute)} exceeds ${MAX_FILE_BYTES} bytes`);
        files.push(absolute);
        if (files.length > maximumFiles) fail(`bundle contains more than ${maximumFiles} files`);
      } else fail(`${path.relative(root, absolute)} is not a regular file or directory`);
    }
  }
  return files.sort();
}

function measurement(files, extension) {
  const selected = extension ? files.filter((file) => path.extname(file) === extension) : files;
  return selected.reduce(
    (total, file) => {
      const bytes = fs.readFileSync(file);
      return { bytes: total.bytes + bytes.byteLength, gzipBytes: total.gzipBytes + gzipSync(bytes).byteLength };
    },
    { bytes: 0, gzipBytes: 0 },
  );
}

function enforce(measured, ceiling, label) {
  for (const metric of ["bytes", "gzipBytes"]) {
    const budget = positiveInteger(ceiling?.[metric], `${label}.${metric}`);
    if (measured[metric] > budget) fail(`${label}.${metric} is ${measured[metric]}, over its ${budget} ceiling`);
  }
}

export function verifyFirstMapBudgets() {
  const budgets = boundedJson(budgetPath, MAX_BUDGET_BYTES);
  if (budgets.format !== "honua.sdk.first-map-budgets.v1") fail("budget format is invalid");
  if (positiveInteger(budgets.runtime?.firstMapMs, "runtime.firstMapMs") !== 5_000) {
    fail("runtime.firstMapMs must match the browser's 5000 ms qualification budget");
  }
  const maximumFiles = positiveInteger(budgets.bundle?.maximumFiles, "bundle.maximumFiles");
  const files = bundleFiles(distRoot, maximumFiles);
  if (files.length === 0) fail("bundle is empty");
  const javascript = measurement(files, ".js");
  const css = measurement(files, ".css");
  const total = measurement(files);
  const largestJavaScript = Math.max(
    0,
    ...files.filter((file) => path.extname(file) === ".js").map((file) => fs.statSync(file).size),
  );
  const maximumSingleJavaScriptBytes = positiveInteger(
    budgets.bundle?.maximumSingleJavaScriptBytes,
    "bundle.maximumSingleJavaScriptBytes",
  );
  if (largestJavaScript > maximumSingleJavaScriptBytes) {
    fail(`largest JavaScript chunk is ${largestJavaScript}, over its ${maximumSingleJavaScriptBytes} ceiling`);
  }
  enforce(javascript, budgets.bundle?.javascript, "bundle.javascript");
  enforce(css, budgets.bundle?.css, "bundle.css");
  enforce(total, budgets.bundle?.total, "bundle.total");
  const report = { files: files.length, javascript, css, total };
  process.stdout.write(
    `First Map budgets passed: files=${report.files} js=${javascript.bytes}/${javascript.gzipBytes} css=${css.bytes}/${css.gzipBytes} total=${total.bytes}/${total.gzipBytes}\n`,
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) verifyFirstMapBudgets();
