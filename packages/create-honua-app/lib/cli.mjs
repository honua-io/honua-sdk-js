// Argument parsing and console output for `npm create honua-app`.
//
// `parseArgs` is pure so the repository test suite can assert the grammar, and
// `run` takes its streams and working directory as options so a test can drive
// a full scaffold in-process without spawning npm or a build.

import fs from "node:fs";
import path from "node:path";

import { scaffoldProject } from "./scaffold.mjs";
import { PACKAGE_ROOT, defaultTemplate, loadTemplateManifest, playgroundLinks, templateIds } from "./templates.mjs";

const USAGE = `Usage: create-honua-app [directory] [options]

Options:
  -t, --template <id>   Starter to scaffold (default: the manifest's default template)
      --list-templates  Print the available templates and exit
      --force           Scaffold into a directory that already has files
  -h, --help            Print this message and exit
  -v, --version         Print the create-honua-app version and exit`;

/** Parse argv (already stripped of node and the script path). */
export function parseArgs(argv) {
  const options = { mode: "scaffold", directory: undefined, templateId: undefined, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.mode = "help";
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      options.mode = "version";
      continue;
    }
    if (argument === "--list-templates") {
      options.mode = "list-templates";
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--template" || argument === "-t") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a template id.`);
      options.templateId = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--template=")) {
      const value = argument.slice("--template=".length);
      if (value.length === 0) throw new Error("--template requires a template id.");
      options.templateId = value;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (options.directory !== undefined) throw new Error(`Unexpected extra argument: ${argument}`);
    options.directory = argument;
  }
  return options;
}

/** Help text, including the live template list so it can never drift. */
export function helpText(manifest) {
  const templates = manifest.templates
    .map((template) => `  ${template.id.padEnd(12)} ${template.summary}${template.default ? " (default)" : ""}`)
    .join("\n");
  return `${USAGE}\n\nTemplates:\n${templates}\n`;
}

/** The `--list-templates` report, with each starter's zero-install playground links. */
export function templateListing(manifest) {
  const lines = [];
  for (const template of manifest.templates) {
    lines.push(`${template.id}${template.default ? " (default)" : ""} — ${template.title}`);
    lines.push(`  ${template.summary}`);
    lines.push(`  SDK: ${manifest.sdk.package}@${manifest.sdk.version}`);
    for (const link of playgroundLinks(manifest, template)) lines.push(`  ${link.title}: ${link.url}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Next-step instructions printed after a successful scaffold. */
export function nextSteps(receipt, cwd) {
  const relative = path.relative(cwd, receipt.targetRoot) || ".";
  return [
    `Created ${receipt.projectName} from the ${receipt.templateId} template in ${relative}.`,
    `Pinned ${receipt.sdk.package}@${receipt.sdk.version}.`,
    "",
    "Next steps:",
    ...(relative === "." ? [] : [`  cd ${relative}`]),
    "  npm install",
    "  npm run dev",
    "",
    "The default lane serves a committed fixture, so the first map needs no account, key, or network.",
    "",
  ].join("\n");
}

function packageVersion(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}

/**
 * Run the CLI. Returns the process exit code instead of calling `process.exit`
 * so the bin wrapper stays the only place that touches process state.
 */
export function run(
  argv,
  { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, packageRoot = PACKAGE_ROOT } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 1;
  }

  const manifest = loadTemplateManifest(packageRoot);
  if (options.mode === "help") {
    stdout.write(helpText(manifest));
    return 0;
  }
  if (options.mode === "version") {
    stdout.write(`${packageVersion(packageRoot)}\n`);
    return 0;
  }
  if (options.mode === "list-templates") {
    stdout.write(templateListing(manifest));
    return 0;
  }

  const directory = options.directory ?? "honua-app";
  const templateId = options.templateId ?? defaultTemplate(manifest).id;
  if (!templateIds(manifest).includes(templateId)) {
    stderr.write(`Unknown template ${JSON.stringify(templateId)}. Available: ${templateIds(manifest).join(", ")}.\n`);
    return 1;
  }

  try {
    const receipt = scaffoldProject({ templateId, directory, force: options.force, cwd, packageRoot });
    stdout.write(nextSteps(receipt, cwd));
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
