import { ESLint } from 'eslint';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baselinePath = path.join(root, 'scripts/eslint-review-baseline.json');

export function findingIdentity(parts) {
  const fingerprint = createHash('sha256').update(JSON.stringify(parts.slice(2))).digest('hex');
  return JSON.stringify([parts[0], parts[1], fingerprint]);
}

export function scopeAt(source, position) {
  const names = [];
  function visit(node) {
    if (position < node.getStart(source) || position >= node.end) return;
    if (ts.isClassLike(node) || ts.isFunctionLike(node)) {
      const name = node.name ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined);
      names.push(name?.getText(source) ?? node.parent.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names.join('.') || '<module>';
}

export function identities(results, sources) {
  const counts = new Map();
  for (const result of results) {
    const relative = path.relative(root, result.filePath).split(path.sep).join('/');
    const text = sources.get(result.filePath);
    const source = ts.createSourceFile(result.filePath, text, ts.ScriptTarget.Latest, true);
    const lines = text.split(/\r?\n/);
    for (const message of result.messages) {
      if (message.fatal) throw new Error(`${relative}: ${message.message}`);
      // Inline disable comments cannot suppress diagnostics; ESLint warns about them.
      if (message.severity !== 2) continue;
      if (!message.ruleId) throw new Error(`${relative}: ${message.message}`);
      const position = source.getPositionOfLineAndCharacter(message.line - 1, message.column - 1);
      const identity = findingIdentity([message.ruleId, relative, message.message,
        scopeAt(source, position), lines[message.line - 1].trim()]);
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
  }
  return counts;
}

export function budgets(rows) {
  const result = new Map();
  for (const row of rows) {
    if (!Array.isArray(row.identity) || row.identity.length !== 3 ||
        !row.identity.every(value => typeof value === 'string') ||
        !/^[a-f0-9]{64}$/.test(row.identity[2]) ||
        !Number.isSafeInteger(row.count) || row.count < 1) throw new Error('Invalid baseline row');
    const key = JSON.stringify(row.identity);
    if (result.has(key)) throw new Error('Duplicate baseline identity');
    result.set(key, row.count);
  }
  return result;
}

export function additions(current, baseline) {
  return [...current].filter(([key, count]) => count > (baseline.get(key) ?? 0));
}

async function main() {
  const lint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'scripts/eslint.review.config.mjs') });
  const results = await lint.lintFiles(['**/*.ts', '**/*.tsx']);
  const sources = new Map(await Promise.all(results.map(async result =>
    [result.filePath, await readFile(result.filePath, 'utf8')])));
  const current = identities(results, sources);
  const capture = process.argv.indexOf('--capture');
  if (capture !== -1) {
    const destination = process.argv[capture + 1] ?? baselinePath;
    const rows = [...current].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) =>
      ({ identity: JSON.parse(key), count }));
    await writeFile(destination, `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`Captured ${[...current.values()].reduce((sum, count) => sum + count, 0)} findings`);
    return;
  }
  const baseline = budgets(JSON.parse(await readFile(baselinePath, 'utf8')));
  const fresh = additions(current, baseline);
  for (const [key, count] of fresh) console.error(`${key}: ${count} findings`);
  console.log(`${fresh.length} new ESLint review findings`);
  if (fresh.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
