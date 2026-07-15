import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const LAUNCH_METHODS = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]);
const PACKAGE_MANAGER_PATTERN = /^(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun(?:\.exe)?)$/i;
const RUN_SCRIPT_NAME_PATTERN = /^(?:runScript|runNpmScript|npmRun|runPackageScript|run-script)$/i;
const PACKAGE_WRAPPER_PATTERN = /^(?:run|exec)(Npm|Pnpm|Yarn|Bun)$/i;
const COMMAND_WRAPPER_NAME_PATTERN = /^(?:command|exec|execute|launch|run|spawn|runCommand|runProcess)$/i;
const SHELL_EXECUTABLE_PATTERN = /^(?:ba|c|da|k|z)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i;
const NODE_EXECUTABLE_PATTERN = /^node(?:\.exe)?$/i;
const PREPARATION_SCRIPT_PATTERN = /^prepare:test-sdk(?::(?:force|already|capture|adopt))?$/;
const PREPARATION_OWNER_PATH_PATTERN = /(?:^|[/\\])scripts[/\\]prepare-sdk-test-artifacts\.mjs$/i;
const OWNED_BUILD_FILE = "scripts/prepare-sdk-test-artifacts.mjs";
const NON_SCRIPT_PACKAGE_COMMANDS = new Set([
  "add",
  "audit",
  "ci",
  "config",
  "dlx",
  "exec",
  "help",
  "init",
  "install",
  "link",
  "list",
  "outdated",
  "pack",
  "publish",
  "remove",
  "root",
  "uninstall",
  "update",
  "view",
  "why",
]);

export function analyzeTestBuildOwnership(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const testRoot = path.resolve(projectRoot, options.testRoot ?? "test");
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const scripts = packageJson.scripts ?? {};
  const entryFiles = walkFiles(testRoot).filter((file) => TEST_FILE_PATTERN.test(file));
  const reachableFiles = collectReachableFiles(projectRoot, entryFiles);
  const violations = [];

  for (const absoluteFile of reachableFiles) {
    const relativeFile = toRelative(projectRoot, absoluteFile);
    const source = fs.readFileSync(absoluteFile, "utf8");
    const sourceFile = ts.createSourceFile(
      relativeFile,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(relativeFile),
    );
    const context = createAnalysisContext(sourceFile, scripts, projectRoot);
    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const launch = launchForCall(node, context);
      if (!launch) return;
      const reason = rootBuildReason(launch, context, relativeFile);
      if (!reason) return;
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({ file: relativeFile, line: position.line + 1, column: position.character + 1, reason });
    });
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column ||
      left.reason.localeCompare(right.reason),
  );
}

export function assertTestBuildOwnership(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const testRoot = path.resolve(projectRoot, options.testRoot ?? "test");
  const entryFiles = walkFiles(testRoot).filter((file) => TEST_FILE_PATTERN.test(file));
  const reachableFiles = collectReachableFiles(projectRoot, entryFiles);
  const violations = analyzeTestBuildOwnership(options);
  if (violations.length > 0) {
    throw new Error(
      `Full SDK compilation is owned only by ${OWNED_BUILD_FILE}:\n${violations
        .map((violation) => `  ${violation.file}:${violation.line}:${violation.column} ${violation.reason}`)
        .join("\n")}`,
    );
  }
  return { filesChecked: reachableFiles.length };
}

function collectReachableFiles(projectRoot, entryFiles) {
  const pending = [...entryFiles];
  const visited = new Set();
  while (pending.length > 0) {
    const absoluteFile = path.resolve(pending.pop());
    if (visited.has(absoluteFile)) continue;
    if (!isWithin(projectRoot, absoluteFile) || absoluteFile.includes(`${path.sep}node_modules${path.sep}`)) continue;
    visited.add(absoluteFile);
    const source = fs.readFileSync(absoluteFile, "utf8");
    const sourceFile = ts.createSourceFile(
      absoluteFile,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(absoluteFile),
    );
    for (const specifier of localModuleSpecifiers(sourceFile)) {
      const resolved = resolveLocalModule(absoluteFile, specifier);
      if (resolved && isWithin(projectRoot, resolved)) pending.push(resolved);
    }
  }
  return [...visited].sort();
}

function createAnalysisContext(sourceFile, scripts, projectRoot) {
  const constDeclarations = new Map();
  const childProcessFunctions = new Map();
  const childProcessNamespaces = new Set();

  visit(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) === ts.NodeFlags.Const
    ) {
      constDeclarations.set(node.name.text, node.initializer);
    }
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (!CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text) || !node.importClause) return;
    const bindings = node.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (LAUNCH_METHODS.has(imported)) childProcessFunctions.set(element.name.text, imported);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      childProcessNamespaces.add(bindings.name.text);
    }
  });

  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    const requiredModule = childProcessRequire(node.initializer);
    if (!requiredModule) return;
    if (requiredModule.method && ts.isIdentifier(node.name)) {
      childProcessFunctions.set(node.name.text, requiredModule.method);
      return;
    }
    if (requiredModule.namespace && ts.isIdentifier(node.name)) {
      childProcessNamespaces.add(node.name.text);
      return;
    }
    if (requiredModule.namespace && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const imported = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
        if (LAUNCH_METHODS.has(imported)) childProcessFunctions.set(element.name.text, imported);
      }
    }
  });

  return { sourceFile, scripts, projectRoot, constDeclarations, childProcessFunctions, childProcessNamespaces };
}

function childProcessRequire(initializer) {
  const resolved = unwrap(initializer);
  if (
    ts.isPropertyAccessExpression(resolved) &&
    LAUNCH_METHODS.has(resolved.name.text) &&
    isChildProcessRequireCall(resolved.expression)
  ) {
    return { method: resolved.name.text };
  }
  return isChildProcessRequireCall(resolved) ? { namespace: true } : undefined;
}

function isChildProcessRequireCall(expression) {
  const resolved = unwrap(expression);
  return (
    ts.isCallExpression(resolved) &&
    ts.isIdentifier(resolved.expression) &&
    resolved.expression.text === "require" &&
    resolved.arguments.length === 1 &&
    ts.isStringLiteral(resolved.arguments[0]) &&
    CHILD_PROCESS_MODULES.has(resolved.arguments[0].text)
  );
}

function launchForCall(call, context) {
  const expression = call.expression;
  if (ts.isIdentifier(expression) && context.childProcessFunctions.has(expression.text)) {
    return { method: context.childProcessFunctions.get(expression.text), call, command: call.arguments[0], argv: call.arguments[1] };
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    context.childProcessNamespaces.has(expression.expression.text) &&
    LAUNCH_METHODS.has(expression.name.text)
  ) {
    return { method: expression.name.text, call, command: call.arguments[0], argv: call.arguments[1] };
  }

  if (ts.isIdentifier(expression) && RUN_SCRIPT_NAME_PATTERN.test(expression.text)) {
    return { method: "run-script", call, script: call.arguments[0] };
  }
  if (ts.isIdentifier(expression)) {
    const wrapper = expression.text.match(PACKAGE_WRAPPER_PATTERN);
    if (wrapper) {
      return {
        method: "package-wrapper",
        manager: wrapper[1].toLowerCase(),
        call,
        argv: call.arguments[0],
      };
    }
  }
  if (
    call.arguments.length > 0 &&
    isCommandWrapperExpression(expression) &&
    ts.isArrayLiteralExpression(unwrap(call.arguments[0]))
  ) {
    const elements = unwrap(call.arguments[0]).elements;
    if (elements.length > 0 && looksLikePackageManager(elements[0], context)) {
      return {
        method: "command-wrapper",
        call,
        command: elements[0],
        argvElements: elements.slice(1),
      };
    }
  }
  return undefined;
}

function isCommandWrapperExpression(expression) {
  if (ts.isIdentifier(expression)) return COMMAND_WRAPPER_NAME_PATTERN.test(expression.text);
  return ts.isPropertyAccessExpression(expression) && COMMAND_WRAPPER_NAME_PATTERN.test(expression.name.text);
}

function enclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function rootBuildReason(launch, context, relativeFile) {
  if (launch.method === "run-script") {
    const scripts = stringValues(launch.script, context);
    if (!scripts || scripts.size === 0) return "dynamic package-script launch is not fixture-bounded";
    for (const script of scripts) {
      if (PREPARATION_SCRIPT_PATTERN.test(script)) {
        return `package script ${script} crosses the prepared-artifact owner boundary from a test`;
      }
      if (scriptRequiresRootCompile(script, context)) return `package script ${script} reaches the root compiler`;
    }
    return undefined;
  }

  if (launch.method === "exec" || launch.method === "execSync") {
    const commands = stringValues(launch.command, context);
    if (!commands) return "dynamic shell command is not fixture-bounded";
    for (const command of commands) {
      const reason = shellRootBuildReason(command, context);
      if (reason && relativeFile !== OWNED_BUILD_FILE) return reason;
    }
    return undefined;
  }

  const commandValues = stringValues(launch.command, context);
  const commandText = launch.command?.getText(context.sourceFile) ?? "";
  let argvElements = launch.argvElements ?? arrayElements(launch.argv, context);

  if (isPreparedArtifactOwnerLaunch(commandValues, commandText, argvElements, context)) {
    return "direct prepared-artifact owner launch crosses the owner boundary from a test";
  }

  const shellLaunch = shellCommandsForLaunch(commandValues, commandText, argvElements, context);
  if (shellLaunch?.dynamic) return "dynamic shell command is not fixture-bounded";
  if (shellLaunch) {
    for (const command of shellLaunch.commands) {
      const reason = shellRootBuildReason(command, context);
      if (reason) return reason;
    }
    return undefined;
  }

  let manager = launch.manager ?? packageManagerFrom(commandValues, commandText);
  if (!manager && argvElements && /(?:^|\.)execPath$/.test(commandText)) {
    const npmCli = argvElements[0];
    const npmCliText = npmCli?.getText(context.sourceFile) ?? "";
    const npmCliManager = npmCli ? packageManagerFrom(stringValues(npmCli, context), npmCliText) : undefined;
    if (npmCliManager) {
      manager = npmCliManager;
      argvElements = argvElements.slice(1);
    }
  }

  if (manager) {
    if (!argvElements) {
      const wrapperName = enclosingFunctionName(launch.call);
      if (wrapperName && PACKAGE_WRAPPER_PATTERN.test(wrapperName)) return undefined;
      return "package-manager argv is dynamic and not fixture-scoped";
    }
    if (isFixtureScopedPackageLaunch(argvElements, context)) return undefined;
    const tscReason = packageManagerTscReason(manager, argvElements, context);
    if (tscReason) return tscReason;
    const scriptNames = packageScriptNames(manager, argvElements, context);
    if (!scriptNames) return "package-manager script is dynamic and not fixture-scoped";
    for (const script of scriptNames) {
      if (PREPARATION_SCRIPT_PATTERN.test(script)) {
        return `package script ${script} crosses the prepared-artifact owner boundary from a test`;
      }
      if (scriptRequiresRootCompile(script, context)) {
        if (relativeFile === OWNED_BUILD_FILE && script === "compile") continue;
        return `package script ${script} reaches the root compiler outside its owner`;
      }
    }
    return undefined;
  }

  if (isDirectTsc(commandValues, commandText, argvElements, context)) {
    if (isFixtureScopedTsc(argvElements, launch.call.arguments[2], context)) return undefined;
    return "root TypeScript compilation is outside the prepared-artifact owner";
  }
  return undefined;
}

function shellRootBuildReason(command, context) {
  if (/\bnode(?:\.exe)?\s+[^;&|]*scripts[/\\]prepare-sdk-test-artifacts\.mjs(?:\s|$)/i.test(command)) {
    return "shell command crosses the prepared-artifact owner boundary from a test";
  }
  if (/(?:^|[;&|]\s*)(?:npx\s+)?tsc(?:\s|$)/i.test(command)) {
    if (!/(?:--project|-p)\s+(?:examples|test\/fixtures|\/tmp|\$\{?TMP)/i.test(command)) {
      return "shell command launches the root TypeScript compiler";
    }
  }
  for (const invocation of shellPackageInvocations(command)) {
    if (invocation.rootTsc) return "shell package manager launches the root TypeScript compiler";
    const script = invocation.script;
    if (!script) continue;
    if (PREPARATION_SCRIPT_PATTERN.test(script)) {
      return `shell package script ${script} crosses the prepared-artifact owner boundary from a test`;
    }
    if (scriptRequiresRootCompile(script, context)) {
      return `shell package script ${script} reaches the root compiler`;
    }
  }
  return undefined;
}

function isPreparedArtifactOwnerLaunch(commandValues, commandText, argvElements, context) {
  if (!isExecutable(commandValues, commandText, NODE_EXECUTABLE_PATTERN) || !argvElements) return false;
  return argvElements.some((element) => {
    const values = stringValues(element, context);
    if (values && [...values].some((value) => PREPARATION_OWNER_PATH_PATTERN.test(value))) return true;
    return PREPARATION_OWNER_PATH_PATTERN.test(element.getText(context.sourceFile).replaceAll('"', ""));
  });
}

function shellCommandsForLaunch(commandValues, commandText, argvElements, context) {
  if (!isExecutable(commandValues, commandText, SHELL_EXECUTABLE_PATTERN)) return undefined;
  if (!argvElements) return { dynamic: true, commands: [] };
  const valueAt = (index) => {
    const values = stringValues(argvElements[index], context);
    return values?.size === 1 ? [...values][0] : undefined;
  };
  const commandFlagIndex = argvElements.findIndex((_, index) =>
    ["-c", "--command", "/c", "-command"].includes(valueAt(index)?.toLowerCase()),
  );
  if (commandFlagIndex < 0) return undefined;
  const commands = stringValues(argvElements[commandFlagIndex + 1], context);
  return commands ? { dynamic: false, commands: [...commands] } : { dynamic: true, commands: [] };
}

function isExecutable(values, expressionText, pattern) {
  if (values && [...values].some((value) => pattern.test(path.basename(value)))) return true;
  const normalizedText = expressionText.replaceAll(/["']/g, "");
  return pattern.test(path.basename(normalizedText));
}

function scriptRequiresRootCompile(scriptName, context, visiting = new Set()) {
  if (visiting.has(scriptName)) return false;
  const nextVisiting = new Set(visiting).add(scriptName);
  for (const lifecycleName of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
    const command = context.scripts[lifecycleName];
    if (typeof command !== "string") continue;
    if (PREPARATION_SCRIPT_PATTERN.test(lifecycleName)) return true;
    if (/(?:^|&&|;|\|)\s*(?:npx\s+)?tsc(?:\s|$)/i.test(command) && !isFixtureTscCommand(command)) return true;
    if (packageCommandRunsRootTsc(command)) return true;
    if (nodeHelpersIn(command).some((helper) => helperLaunchesRootCompile(context, helper))) return true;

    for (const calledScript of packageScriptsIn(command)) {
      if (PREPARATION_SCRIPT_PATTERN.test(calledScript)) return true;
      if (scriptRequiresRootCompile(calledScript, context, nextVisiting)) return true;
    }
  }
  return false;
}

function packageScriptsIn(command) {
  return shellPackageInvocations(command).flatMap((invocation) =>
    invocation.script ? [invocation.script] : [],
  );
}

function packageCommandRunsRootTsc(command) {
  return shellPackageInvocations(command).some((invocation) => invocation.rootTsc);
}

function shellPackageInvocations(command) {
  const invocations = [];
  for (const segment of command.split(/&&|;|\|/)) {
    const tokens = shellTokens(segment);
    const managerIndex = tokens.findIndex((token) => PACKAGE_MANAGER_PATTERN.test(path.basename(token)));
    if (managerIndex < 0) {
      if (/^npx$/i.test(tokens[0] ?? "") && /^(?:tsc|typescript)$/i.test(path.basename(tokens[1] ?? ""))) {
        invocations.push({ rootTsc: true });
      }
      continue;
    }
    const manager = path.basename(tokens[managerIndex]).toLowerCase().replace(/\.cmd$/, "");
    let index = skipPackageOptions(tokens, managerIndex + 1);
    const commandName = tokens[index];
    if (!commandName) continue;
    if (["exec", "dlx", "x"].includes(commandName)) {
      index = skipPackageOptions(tokens, index + 1);
      invocations.push({ rootTsc: /^(?:tsc|typescript)$/i.test(path.basename(tokens[index] ?? "")) });
      continue;
    }
    if (manager === "npm") {
      if (["run", "run-script"].includes(commandName)) {
        index = skipPackageOptions(tokens, index + 1);
        invocations.push({ script: tokens[index] });
      } else if (["test", "t"].includes(commandName)) {
        invocations.push({ script: "test" });
      }
      continue;
    }
    if (commandName === "run") {
      index = skipPackageOptions(tokens, index + 1);
      invocations.push({ script: tokens[index] });
    } else if (!NON_SCRIPT_PACKAGE_COMMANDS.has(commandName)) {
      invocations.push({ script: commandName });
    }
  }
  return invocations;
}

function shellTokens(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function skipPackageOptions(tokens, start) {
  let index = start;
  while (tokens[index]?.startsWith("-")) {
    if (["--prefix", "--cwd", "--workspace", "-C", "-w"].includes(tokens[index])) index += 2;
    else index += 1;
  }
  return index;
}

function nodeHelpersIn(command) {
  const helpers = [];
  for (const segment of command.split(/&&|;|\|/)) {
    const tokens = shellTokens(segment);
    const nodeIndex = tokens.findIndex((token) => /^(?:node|node\.exe)$/i.test(path.basename(token)));
    if (nodeIndex < 0) continue;
    const helper = tokens.slice(nodeIndex + 1).find((token) => !token.startsWith("-"));
    if (helper && SOURCE_EXTENSIONS.includes(path.extname(helper))) helpers.push(helper);
  }
  return helpers;
}

function helperLaunchesRootCompile(parentContext, helper) {
  const absoluteHelper = resolveLocalModule(path.join(parentContext.projectRoot, "package.json"), `./${helper}`);
  if (!absoluteHelper || !isWithin(parentContext.projectRoot, absoluteHelper)) return false;
  for (const absoluteFile of collectReachableFiles(parentContext.projectRoot, [absoluteHelper])) {
    const relativeFile = toRelative(parentContext.projectRoot, absoluteFile);
    const sourceFile = ts.createSourceFile(
      relativeFile,
      fs.readFileSync(absoluteFile, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(relativeFile),
    );
    const context = createAnalysisContext(sourceFile, parentContext.scripts, parentContext.projectRoot);
    let reachesCompiler = false;
    visit(sourceFile, (node) => {
      if (reachesCompiler || !ts.isCallExpression(node)) return;
      const launch = launchForCall(node, context);
      if (launch && rootBuildReason(launch, context, relativeFile)) reachesCompiler = true;
    });
    if (reachesCompiler) return true;
  }
  return false;
}

function isFixtureTscCommand(command) {
  const match = command.match(/(?:--project|-p)\s+([^\s;&|]+)/i);
  return Boolean(match && /^(?:examples|test\/fixtures)\//.test(match[1]));
}

function packageScriptNames(manager, elements, context) {
  const valueAt = (index) => {
    const values = stringValues(elements[index], context);
    return values?.size === 1 ? [...values][0] : undefined;
  };
  let index = 0;
  while (index < elements.length) {
    const token = valueAt(index);
    if (["--prefix", "--cwd", "-C"].includes(token)) {
      index += 2;
      continue;
    }
    if (token?.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const command = valueAt(index);
  if (!command) return undefined;
  if (manager === "npm") {
    if (command === "run" || command === "run-script") {
      let scriptIndex = index + 1;
      while (valueAt(scriptIndex)?.startsWith("-")) scriptIndex += 1;
      const script = valueAt(scriptIndex);
      return script ? [script] : undefined;
    }
    if (command === "test" || command === "t") return ["test"];
    return [];
  }
  if (command === "run") {
    let scriptIndex = index + 1;
    while (valueAt(scriptIndex)?.startsWith("-")) scriptIndex += 1;
    const script = valueAt(scriptIndex);
    return script ? [script] : undefined;
  }
  if (NON_SCRIPT_PACKAGE_COMMANDS.has(command)) return [];
  return [command];
}

function packageManagerTscReason(_manager, elements, context) {
  const valueAt = (index) => {
    const values = stringValues(elements[index], context);
    return values?.size === 1 ? [...values][0] : undefined;
  };
  let index = 0;
  while (index < elements.length && valueAt(index)?.startsWith("-")) {
    index += ["--prefix", "--cwd", "--workspace", "-C", "-w"].includes(valueAt(index)) ? 2 : 1;
  }
  if (!["exec", "dlx", "x"].includes(valueAt(index))) return undefined;
  index += 1;
  while (index < elements.length && valueAt(index)?.startsWith("-")) index += 1;
  return /^(?:tsc|typescript)$/i.test(path.basename(valueAt(index) ?? ""))
    ? "package manager launches the root TypeScript compiler"
    : undefined;
}

function isFixtureScopedPackageLaunch(elements, context) {
  for (let index = 0; index < elements.length - 1; index += 1) {
    const flags = stringValues(elements[index], context);
    if (!flags || ![...flags].some((value) => ["--prefix", "--cwd", "-C"].includes(value))) continue;
    if (isFixturePathExpression(elements[index + 1], context)) return true;
  }
  return false;
}

function isDirectTsc(commandValues, commandText, argvElements, context) {
  if (commandValues && [...commandValues].some((value) => /(?:^|[/\\])(?:tsc|tsc\.cmd)$/i.test(value))) return true;
  if (/\btsc(?:Bin|Path|Command)?\b/i.test(commandText)) return true;
  if (!argvElements || argvElements.length === 0) return false;
  const firstValues = stringValues(argvElements[0], context);
  const firstText = argvElements[0].getText(context.sourceFile);
  return (
    Boolean(firstValues && [...firstValues].some((value) => /(?:^|[/\\])tsc(?:\.js|\.cmd)?$/i.test(value))) ||
    /\btsc(?:Bin|Path|Command)?\b/i.test(firstText)
  );
}

function isFixtureScopedTsc(argvElements, optionsExpression, context) {
  if (argvElements) {
    for (let index = 0; index < argvElements.length - 1; index += 1) {
      const flags = stringValues(argvElements[index], context);
      if (!flags || ![...flags].some((value) => ["--project", "-p"].includes(value))) continue;
      if (isFixturePathExpression(argvElements[index + 1], context)) return true;
    }
  }
  if (optionsExpression && ts.isObjectLiteralExpression(unwrap(optionsExpression))) {
    const cwd = propertyInitializer(unwrap(optionsExpression), "cwd");
    if (cwd && isFixturePathExpression(cwd, context)) return true;
  }
  return false;
}

function isFixturePathExpression(expression, context) {
  const values = stringValues(expression, context);
  if (values && values.size > 0) {
    return [...values].every((value) => {
      const normalized = value.replaceAll("\\", "/");
      return (
        normalized !== "." &&
        normalized !== "./" &&
        (normalized.startsWith("examples/") || normalized.startsWith("test/fixtures/") || normalized.startsWith("/tmp/"))
      );
    });
  }
  const text = expression.getText(context.sourceFile);
  return /(?:fixture|example|workingCopy|temp(?:Dir|Root)?|outputDir)/i.test(text) && !/\b(?:projectRoot|repoRoot)\b/.test(text);
}

function packageManagerFrom(values, expressionText) {
  if (values) {
    for (const value of values) {
      const executable = value.split(/[\\/]/).at(-1);
      if (PACKAGE_MANAGER_PATTERN.test(executable)) return executable.toLowerCase().replace(/\.cmd$/, "");
    }
  }
  if (/\bnpm_execpath\b/i.test(expressionText)) return "npm";
  const identifier = expressionText.match(/\b(npm|pnpm|yarn|bun)(?:Command|Cmd|Executable)?\b/i)?.[1];
  return identifier?.toLowerCase();
}

function looksLikePackageManager(expression, context) {
  return Boolean(packageManagerFrom(stringValues(expression, context), expression.getText(context.sourceFile)));
}

function arrayElements(expression, context) {
  if (!expression) return undefined;
  const unwrapped = unwrap(resolveConst(expression, context));
  return ts.isArrayLiteralExpression(unwrapped) && !unwrapped.elements.some(ts.isSpreadElement) ? [...unwrapped.elements] : undefined;
}

function stringValues(expression, context, seen = new Set()) {
  if (!expression) return undefined;
  const resolved = unwrap(resolveConst(expression, context, seen));
  if (ts.isStringLiteralLike(resolved)) return new Set([resolved.text]);
  if (ts.isNoSubstitutionTemplateLiteral(resolved)) return new Set([resolved.text]);
  if (ts.isConditionalExpression(resolved)) {
    const left = stringValues(resolved.whenTrue, context, seen);
    const right = stringValues(resolved.whenFalse, context, seen);
    return left && right ? new Set([...left, ...right]) : undefined;
  }
  if (ts.isBinaryExpression(resolved) && resolved.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringValues(resolved.left, context, seen);
    const right = stringValues(resolved.right, context, seen);
    if (!left || !right) return undefined;
    const values = new Set();
    for (const leftValue of left) for (const rightValue of right) values.add(`${leftValue}${rightValue}`);
    return values;
  }
  if (
    ts.isPropertyAccessExpression(resolved) &&
    resolved.name.text === "execPath" &&
    resolved.expression.getText(context.sourceFile).endsWith("process")
  ) {
    return new Set([process.execPath]);
  }
  return undefined;
}

function resolveConst(expression, context, seen = new Set()) {
  const unwrapped = unwrap(expression);
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) return unwrapped;
  const initializer = context.constDeclarations.get(unwrapped.text);
  if (!initializer) return unwrapped;
  seen.add(unwrapped.text);
  return resolveConst(initializer, context, seen);
}

function unwrap(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyInitializer(object, name) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    if (propertyName === name) return property.initializer;
  }
  return undefined;
}

function localModuleSpecifiers(sourceFile) {
  const specifiers = [];
  visit(sourceFile, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(".")
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith(".") &&
      ((ts.isIdentifier(node.expression) && ["require", "import"].includes(node.expression.text)) ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      specifiers.push(node.arguments[0].text);
    }
  });
  return specifiers;
}

function resolveLocalModule(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base];
  if (path.extname(base)) {
    const withoutExtension = base.slice(0, -path.extname(base).length);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${withoutExtension}${extension}`);
  } else {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  }
  return candidates.find((candidate) => {
    try {
      return fs.lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function walkFiles(root) {
  const files = [];
  const visitDirectory = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visitDirectory(entryPath);
      else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) files.push(entryPath);
    }
  };
  visitDirectory(root);
  return files.sort();
}

function scriptKindFor(file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function toRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
