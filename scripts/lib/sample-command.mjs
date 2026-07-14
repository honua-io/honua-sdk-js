const NPM_SCRIPT_PATTERN = /^[a-z0-9]+(?::[a-z0-9-]+)*$/;
const PLAYWRIGHT_FILE_PATTERN = /^test\/playwright\/[a-z0-9-]+\.spec\.mjs$/;
const VITEST_FILE_PATTERN = /^test\/(?:[a-z0-9-]+\/)*[a-z0-9.-]+\.test\.ts$/;

export function parseSampleCommand(command) {
  if (typeof command !== "string" || command.length === 0 || /[\0\r\n]/.test(command)) {
    throw new Error("sample command must be one non-empty line");
  }

  const npm = /^npm run ([a-z0-9:-]+)$/.exec(command);
  if (npm) {
    if (!NPM_SCRIPT_PATTERN.test(npm[1])) throw new Error(`unsafe npm sample script: ${command}`);
    return ["npm", "run", npm[1]];
  }

  const playwright = /^npx playwright test (\S+)$/.exec(command);
  if (playwright) {
    if (!PLAYWRIGHT_FILE_PATTERN.test(playwright[1])) {
      throw new Error(`unsafe Playwright sample target: ${command}`);
    }
    return ["npx", "--no-install", "playwright", "test", playwright[1]];
  }

  const vitest = /^npx vitest run (\S+)$/.exec(command);
  if (vitest) {
    if (!VITEST_FILE_PATTERN.test(vitest[1])) throw new Error(`unsafe Vitest sample target: ${command}`);
    return ["npx", "--no-install", "vitest", "run", vitest[1]];
  }

  throw new Error(`unsupported sample command: ${command}`);
}

export function canonicalCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value === "")) {
    throw new Error("command argv must be a non-empty string array");
  }
  if (argv.some((value) => /[\0\r\n]/.test(value))) throw new Error("command argv contains a control character");
  return JSON.stringify(argv);
}

export function isPlaywrightCommand(argv) {
  return (
    (argv[0] === "npm" && argv[1] === "run" && argv[2]?.startsWith("test:playwright:")) ||
    (argv[0] === "npx" && argv[1] === "--no-install" && argv[2] === "playwright")
  );
}

export function classifySampleCommand(argv) {
  const script = argv[0] === "npm" && argv[1] === "run" ? argv[2] : undefined;
  if (script?.endsWith(":typecheck")) return "typecheck";
  if (script?.endsWith(":build")) return "build";
  return "test";
}
