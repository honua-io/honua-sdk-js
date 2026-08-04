import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { parseArgs, run, templateListing } from "../../packages/create-honua-app/lib/cli.mjs";
import { collectTemplateFiles, projectNameFromDirectory, scaffoldProject } from "../../packages/create-honua-app/lib/scaffold.mjs";
import {
  defaultTemplate,
  loadTemplateManifest,
  playgroundLinks,
  templateIds,
  templateRoot,
} from "../../packages/create-honua-app/lib/templates.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_ROOT = path.join(ROOT, "packages/create-honua-app");
const workspaces = [];

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "create-honua-app-test-"));
  workspaces.push(directory);
  return directory;
}

function captureStreams() {
  const chunks = { stdout: "", stderr: "" };
  return {
    chunks,
    stdout: {
      write(value) {
        chunks.stdout += value;
      },
    },
    stderr: {
      write(value) {
        chunks.stderr += value;
      },
    },
  };
}

after(() => {
  for (const directory of workspaces) fs.rmSync(directory, { recursive: true, force: true });
});

describe("create-honua-app argument grammar", () => {
  it("defaults to a scaffold with no template override", () => {
    assert.deepEqual(parseArgs(["my-map"]), { mode: "scaffold", directory: "my-map", templateId: undefined, force: false });
  });

  it("accepts both template spellings and --force", () => {
    assert.equal(parseArgs(["my-map", "--template", "react-ts"]).templateId, "react-ts");
    assert.equal(parseArgs(["-t", "react-ts", "my-map"]).templateId, "react-ts");
    assert.equal(parseArgs(["--template=react-ts", "my-map"]).templateId, "react-ts");
    assert.equal(parseArgs(["my-map", "--force"]).force, true);
  });

  it("recognizes the informational modes", () => {
    assert.equal(parseArgs(["--help"]).mode, "help");
    assert.equal(parseArgs(["-v"]).mode, "version");
    assert.equal(parseArgs(["--list-templates"]).mode, "list-templates");
  });

  it("rejects unknown options, missing values, and extra positionals", () => {
    assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
    assert.throws(() => parseArgs(["--template"]), /requires a template id/);
    assert.throws(() => parseArgs(["--template", "--force"]), /requires a template id/);
    assert.throws(() => parseArgs(["one", "two"]), /Unexpected extra argument/);
  });
});

describe("template manifest", () => {
  const manifest = loadTemplateManifest(PACKAGE_ROOT);

  it("advertises the vanilla and React starters with exactly one default", () => {
    assert.deepEqual(templateIds(manifest), ["vanilla-ts", "react-ts"]);
    assert.equal(defaultTemplate(manifest).id, "vanilla-ts");
  });

  it("pins every template to the manifest's published SDK version", () => {
    for (const template of manifest.templates) {
      const projectManifest = JSON.parse(
        fs.readFileSync(path.join(templateRoot(manifest, template.id, PACKAGE_ROOT), "package.json"), "utf8"),
      );
      assert.equal(projectManifest.dependencies[manifest.sdk.package], manifest.sdk.version);
    }
  });

  it("derives query-free https playground links that address the template directory", () => {
    for (const template of manifest.templates) {
      const links = playgroundLinks(manifest, template);
      assert.equal(links.length, manifest.playgroundProviders.length);
      for (const link of links) {
        const provider = manifest.playgroundProviders.find((entry) => entry.id === link.providerId);
        const url = new URL(link.url);
        // Compare parsed origins instead of matching a URL prefix as a
        // substring, which any host containing the expected one would satisfy.
        assert.equal(url.origin, new URL(provider.urlTemplate).origin);
        assert.equal(url.protocol, "https:");
        assert.equal(url.search, "");
        assert.equal(url.hash, "");
        assert.ok(url.pathname.endsWith(`/${template.path}`));
      }
    }
  });

  it("addresses the repository directory on the StackBlitz origin", () => {
    const [first] = manifest.templates;
    const link = playgroundLinks(manifest, first).find((entry) => entry.providerId === "stackblitz");
    const url = new URL(link.url);
    assert.equal(url.origin, "https://stackblitz.com");
    assert.equal(url.pathname, `/github/honua-io/honua-sdk-js/tree/trunk/${first.path}`);
  });

  it("lists every template and its playground links", () => {
    const listing = templateListing(manifest);
    const lines = listing.split("\n").map((line) => line.trim());
    for (const template of manifest.templates) {
      assert.ok(lines.includes(`${template.id}${template.default ? " (default)" : ""} — ${template.title}`));
      for (const link of playgroundLinks(manifest, template)) {
        assert.ok(lines.includes(`${link.title}: ${link.url}`));
      }
    }
  });
});

describe("project names", () => {
  it("derives a lowercase npm name from the directory", () => {
    assert.equal(projectNameFromDirectory("/tmp/My-Map"), "my-map");
  });

  it("rejects names npm cannot use", () => {
    assert.throws(() => projectNameFromDirectory("/tmp/.hidden"), /not a valid npm package name/);
    assert.throws(() => projectNameFromDirectory("/tmp/has space"), /not a valid npm package name/);
  });
});

describe("scaffolding", () => {
  it("copies a template, renames _gitignore, and stamps the project name", () => {
    const cwd = workspace();
    const receipt = scaffoldProject({ templateId: "vanilla-ts", directory: "my-map", cwd, packageRoot: PACKAGE_ROOT });
    assert.equal(receipt.projectName, "my-map");
    assert.equal(receipt.templateId, "vanilla-ts");

    const target = path.join(cwd, "my-map");
    for (const relative of ["package.json", "index.html", "vite.config.ts", "src/main.ts", "fixtures/layer.json"]) {
      assert.ok(fs.existsSync(path.join(target, relative)), `expected ${relative}`);
    }
    assert.ok(fs.existsSync(path.join(target, ".gitignore")));
    assert.ok(!fs.existsSync(path.join(target, "_gitignore")));
    assert.ok(!fs.existsSync(path.join(target, ".stackblitzrc")), "playground-only files stay out of scaffolds");

    const projectManifest = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    assert.equal(projectManifest.name, "my-map");
    assert.ok(projectManifest.dependencies["@honua/sdk-js"]);
  });

  it("scaffolds the React starter with its own entry point", () => {
    const cwd = workspace();
    scaffoldProject({ templateId: "react-ts", directory: "react-map", cwd, packageRoot: PACKAGE_ROOT });
    assert.ok(fs.existsSync(path.join(cwd, "react-map/src/App.tsx")));
    assert.ok(fs.existsSync(path.join(cwd, "react-map/src/main.tsx")));
  });

  it("refuses a non-empty directory unless forced", () => {
    const cwd = workspace();
    fs.mkdirSync(path.join(cwd, "occupied"));
    fs.writeFileSync(path.join(cwd, "occupied/notes.txt"), "keep me\n");
    assert.throws(
      () => scaffoldProject({ templateId: "vanilla-ts", directory: "occupied", cwd, packageRoot: PACKAGE_ROOT }),
      /is not empty/,
    );
    scaffoldProject({ templateId: "vanilla-ts", directory: "occupied", cwd, force: true, packageRoot: PACKAGE_ROOT });
    assert.ok(fs.existsSync(path.join(cwd, "occupied/src/main.ts")));
    assert.ok(fs.existsSync(path.join(cwd, "occupied/notes.txt")));
  });

  it("rejects an unknown template", () => {
    const cwd = workspace();
    assert.throws(
      () => scaffoldProject({ templateId: "svelte-ts", directory: "x", cwd, packageRoot: PACKAGE_ROOT }),
      /Unknown template/,
    );
  });

  it("copies every template file except the playground configuration", () => {
    const manifest = loadTemplateManifest(PACKAGE_ROOT);
    const cwd = workspace();
    const receipt = scaffoldProject({ templateId: "vanilla-ts", directory: "counted", cwd, packageRoot: PACKAGE_ROOT });
    const templateFiles = collectTemplateFiles(templateRoot(manifest, "vanilla-ts", PACKAGE_ROOT));
    assert.equal(receipt.files.length, templateFiles.length - 1);
  });
});

describe("cli run", () => {
  it("scaffolds and reports next steps", () => {
    const cwd = workspace();
    const streams = captureStreams();
    const code = run(["fresh-map"], { cwd, stdout: streams.stdout, stderr: streams.stderr, packageRoot: PACKAGE_ROOT });
    assert.equal(code, 0);
    assert.match(streams.chunks.stdout, /npm run dev/);
    assert.ok(fs.existsSync(path.join(cwd, "fresh-map/src/main.ts")));
  });

  it("reports an unknown template without writing anything", () => {
    const cwd = workspace();
    const streams = captureStreams();
    const code = run(["x", "--template", "nope"], {
      cwd,
      stdout: streams.stdout,
      stderr: streams.stderr,
      packageRoot: PACKAGE_ROOT,
    });
    assert.equal(code, 1);
    assert.match(streams.chunks.stderr, /Unknown template/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it("prints help and the version", () => {
    const streams = captureStreams();
    assert.equal(run(["--help"], { ...streams, packageRoot: PACKAGE_ROOT }), 0);
    assert.match(streams.chunks.stdout, /--template/);
    const version = captureStreams();
    assert.equal(run(["--version"], { ...version, packageRoot: PACKAGE_ROOT }), 0);
    assert.match(version.chunks.stdout, /^\d+\.\d+\.\d+/);
  });
});
