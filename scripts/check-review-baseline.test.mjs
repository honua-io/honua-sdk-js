import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { identities, budgets, additions, findingIdentity } from './check-review-baseline.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'honua-eslint-'));
  const filename = path.join(directory, 'finding.ts');
  await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['*.ts'] }));
  const lint = new ESLint({ cwd: directory, overrideConfigFile: true, overrideConfig: [{
    files: ['**/*.ts'], languageOptions: { parser: tseslint.parser,
      parserOptions: { project: path.join(directory, 'tsconfig.json') } },
    plugins: { '@typescript-eslint': tseslint.plugin }, linterOptions: { noInlineConfig: true },
    rules: { 'max-params': ['error', 3], 'max-depth': ['error', 2],
      '@typescript-eslint/no-floating-promises': 'error' },
  }] });
  async function findings(text) {
    await writeFile(filename, text);
    return identities(await lint.lintFiles(filename), new Map([[filename, text]]));
  }
  try { await run(findings); } finally { await rm(directory, { recursive: true, force: true }); }
}

const source = `function old(a: number, b: number, c: number, d: number) {
  if (a) { if (b) { if (c) { console.log(d); } } }
  Promise.resolve(1);
}`;

test('actual typed lint reports all three requested rules and ignores disable comments', async () => {
  await fixture(async findings => {
    const current = await findings('// eslint-disable\n' + source);
    assert.deepEqual(new Set([...current.keys()].map(key => JSON.parse(key)[0])),
      new Set(['max-params', 'max-depth', '@typescript-eslint/no-floating-promises']));
  });
});

test('unused inline directives produce warnings without hiding errors', async () => {
  await fixture(async findings => {
    const baseline = await findings(source);
    const current = await findings('// eslint-disable-next-line @typescript-eslint/no-use-before-define\n' + source);
    assert.deepEqual(current, baseline);
  });
});

test('line shifts preserve budgets; replacement functions and count growth fail', async () => {
  await fixture(async findings => {
    const baseline = await findings(source);
    assert.equal(additions(await findings('\n\n' + source), baseline).length, 0);
    assert.equal(additions(await findings(source.replace('old(', 'fresh(')), baseline).length, 3);
    const duplicate = source.replace('Promise.resolve(1);', 'Promise.resolve(1);\n  Promise.resolve(1);');
    assert.equal(additions(await findings(duplicate), baseline).length, 1);
  });
});

test('anonymous callbacks at a new call site cannot inherit old debt', async () => {
  await fixture(async findings => {
    const old = 'declare const old: (action: () => void) => void;\nold(() => {\n  Promise.resolve(1);\n});';
    const baseline = await findings(old);
    const replacement = old.replaceAll('old', 'fresh');
    assert.equal(additions(await findings('\n' + old), baseline).length, 0);
    assert.equal(additions(await findings(old.replace('  Promise', '\n  Promise')), baseline).length, 0);
    assert.equal(additions(await findings(replacement), baseline).length, 1);
  });
});

test('malformed input fails instead of silently accepting parser failures', async () => {
  await fixture(async findings => assert.rejects(findings('function {'), /Parsing error/));
});

test('sibling callbacks cannot transfer debt even with identical callees or labels', async () => {
  await fixture(async findings => {
    for (const secondLabel of ['second', 'first']) {
      const prefix = 'declare const it: (name: string, action: () => void) => void;\n';
      const first = "it('first', () => {\n  Promise.resolve(1);\n});\n";
      const second = `it('${secondLabel}', () => {\n  void Promise.resolve(1);\n});\n`;
      const baseline = await findings(prefix + first + second);
      const moved = prefix + first.replace('  Promise', '  void Promise') + second.replace('void Promise', 'Promise');
      assert.equal(additions(await findings(moved), baseline).length, 1);
      assert.equal(additions(await findings('\n' + prefix + first + second), baseline).length, 0);
    }
  });
});

test('object methods, property callbacks and returned siblings cannot transfer debt', async () => {
  await fixture(async findings => {
    for (const declaration of [
      'const first = { run() { BODY } }; const second = { run() { SAFE } };',
      'const first = { run: () => { BODY } }; const second = { run: () => { SAFE } };',
      'const handlers = [{ run() { BODY } }, { run() { SAFE } }];',
      'if (flag) return () => { BODY }; return () => { SAFE };',
      'if (flag) return { run() { BODY } }; return { run() { SAFE } };',
    ]) {
      const template = `function outer(flag: boolean) { ${declaration} }`;
      const old = template.replace('BODY', '\nPromise.resolve(1);\n').replace('SAFE', '\nvoid Promise.resolve(1);\n');
      const moved = template.replace('BODY', '\nvoid Promise.resolve(1);\n').replace('SAFE', '\nPromise.resolve(1);\n');
      const baseline = await findings(old);
      assert.equal(baseline.size, 1);
      assert.equal(additions(await findings(moved), baseline).length, 1, declaration);
      assert.equal(additions(await findings('\n' + old), baseline).length, 0);
    }
  });
});

test('invalid and duplicate baseline rows fail closed', () => {
  const row = { identity: JSON.parse(findingIdentity(['max-depth', 'a.ts', 'message', 'old', 'line'])), count: 1 };
  assert.throws(() => budgets([row, row]), /Duplicate/);
  assert.throws(() => budgets([{ ...row, count: true }]), /Invalid/);
  assert.throws(() => budgets([{ identity: ['max-depth', 'a.ts', 'invalid'], count: 1 }]), /Invalid/);
});

test('same-named block-local functions cannot transfer baseline debt', async () => {
  await fixture(async findings => {
    for (const binding of ['const run = () => { BODY };', 'function run() { BODY }']) {
      const template = `function outer(flag: boolean) { if (flag) { ${binding} } else { ${binding} } }`;
      const old = template.replace('BODY', '\nPromise.resolve(1);\n').replace('BODY', '\nvoid Promise.resolve(1);\n');
      const moved = template.replace('BODY', '\nvoid Promise.resolve(1);\n').replace('BODY', '\nPromise.resolve(1);\n');
      const baseline = await findings(old);
      assert.equal(baseline.size, 1);
      assert.equal(additions(await findings(moved), baseline).length, 1, binding);
      assert.equal(additions(await findings('\n' + old), baseline).length, 0);
    }
  });
});

test('production config resolves SDK source imports without built declarations', async () => {
  const filename = path.resolve('examples/review-baseline-regression.ts');
  const text = "import { HonuaClient } from '@honua/sdk-js';\nnew HonuaClient({ baseUrl: 'https://example.invalid' }).queryFeatures({ serviceId: 'a', layerId: 0 });\n";
  const lint = new ESLint({ overrideConfigFile: 'scripts/eslint.review.config.mjs' });
  await writeFile(filename, text, { flag: 'wx' });
  try {
    const results = await lint.lintFiles(filename);
    const current = identities(results, new Map([[filename, text]]));
    assert.ok([...current.keys()].some(key => JSON.parse(key)[0] === '@typescript-eslint/no-floating-promises'));
  } finally { await rm(filename); }
  const config = JSON.parse(await readFile('scripts/tsconfig.review.json', 'utf8'));
  assert.equal(config.compilerOptions.paths['@honua/sdk-js'][0], '../src/index.ts');
});

test('production config resolves imported MCP promises', async () => {
  const filename = path.resolve('mcp/src/review-baseline-regression.ts');
  const text = "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nnew Client({ name: 'regression', version: '1' }).close();\n";
  const lint = new ESLint({ overrideConfigFile: 'scripts/eslint.review.config.mjs' });
  await writeFile(filename, text, { flag: 'wx' });
  try {
    const current = identities(await lint.lintFiles(filename), new Map([[filename, text]]));
    assert.ok([...current.keys()].some(key => JSON.parse(key)[0] === '@typescript-eslint/no-floating-promises'));
  } finally { await rm(filename); }
});


test('named expressions retain call-site and sibling identities', async () => {
  await fixture(async findings => {
    for (const second of ['second', 'first']) {
      const declarations = 'declare const first: (f: () => void) => void; declare const second: typeof first;\n';
      const template = declarations + `first(function run() { BODY }); ${second}(function run() { SAFE });`;
      const old = template.replace('BODY', '\nPromise.resolve(1);\n').replace('SAFE', '\nvoid Promise.resolve(1);\n');
      const moved = template.replace('BODY', '\nvoid Promise.resolve(1);\n').replace('SAFE', '\nPromise.resolve(1);\n');
      assert.equal(additions(await findings(moved), await findings(old)).length, 1);
    }
  });
});

test('compliant returns and calls in unrelated functions preserve existing budgets', async () => {
  await fixture(async findings => {
    for (const body of [
      'return () => { BODY };',
      'return { run() { BODY } };',
      'use(() => { BODY });',
      'use(function run() { BODY });',
    ]) {
      const declarations = 'declare const use: (f: () => void) => void;\n';
      const old = declarations + 'function earlier() {}\nfunction later() { ' + body.replace('BODY', '\nPromise.resolve(1);\n') + ' }';
      const edited = old.replace('function earlier() {}', 'function earlier() { ' + body.replace('BODY', '\nvoid Promise.resolve(1);\n') + ' }');
      assert.equal(additions(await findings(edited), await findings(old)).length, 0, body);
    }
  });
});


test('class member kind and static identity prevent baseline transfers', async () => {
  await fixture(async findings => {
    for (const declaration of [
      'run() { BODY } static run() { SAFE }',
      'get value() { BODY return 1; } set value(value: number) { SAFE }',
    ]) {
      const template = `class Example { ${declaration} }`;
      const old = template.replace('BODY', '\nPromise.resolve(1);\n').replace('SAFE', '\nvoid Promise.resolve(1);\n');
      const moved = template.replace('BODY', '\nvoid Promise.resolve(1);\n').replace('SAFE', '\nPromise.resolve(1);\n');
      const baseline = await findings(old);
      assert.equal(baseline.size, 1);
      assert.equal(additions(await findings(moved), baseline).length, 1, declaration);
      assert.equal(additions(await findings('\n' + old), baseline).length, 0);
    }
  });
});
