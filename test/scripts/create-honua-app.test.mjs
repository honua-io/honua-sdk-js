import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { parseArgs, run, templateListing } from "../../packages/create-honua-app/lib/cli.mjs";
import { collectTemplateFiles, projectNameFromDirectory, scaffoldProject } from "../../packages/create-honua-app/lib/scaffold.mjs";
import {
  isStableVersion,
  npmCliPath,
  onPinnedLine,
  packumentUrl,
  parseVersion,
  registryUrl,
  resolveSdkVersion,
} from "../../packages/create-honua-app/lib/sdk-version.mjs";
import {
  defaultTemplate,
  isChannelName,
  loadTemplateManifest,
  playgroundLinks,
  templateIds,
  templateRoot,
} from "../../packages/create-honua-app/lib/templates.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_ROOT = path.join(ROOT, "packages/create-honua-app");
const workspaces = [];

/**
 * The certified @honua/sdk-js the starters fall back to. It moves only by a
 * deliberate edit once a release certifies a new SDK (honua-release#376, R25),
 * so a release bump that carries an uncertified version into the manifest
 * fails here instead of shipping in the next create-honua-app.
 */
const CERTIFIED_SDK_VERSION = "0.1.12";

/** A registry fetch that always fails, so in-process scaffolds never touch the network. */
async function offlineFetch() {
  throw new Error("offline");
}

/** A registry fetch serving one package document and recording the URLs it was asked for. */
function registryFetch(document, requested = []) {
  return async (url) => {
    requested.push(url);
    return new Response(JSON.stringify(document), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function copyPackage(mutate) {
  const directory = workspace();
  fs.cpSync(PACKAGE_ROOT, directory, { recursive: true });
  const manifestPath = path.join(directory, "templates.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

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
    assert.deepEqual(parseArgs(["my-map"]), {
      mode: "scaffold",
      directory: "my-map",
      templateId: undefined,
      sdkVersion: undefined,
      force: false,
    });
  });

  it("accepts both template spellings and --force", () => {
    assert.equal(parseArgs(["my-map", "--template", "react-ts"]).templateId, "react-ts");
    assert.equal(parseArgs(["-t", "react-ts", "my-map"]).templateId, "react-ts");
    assert.equal(parseArgs(["--template=react-ts", "my-map"]).templateId, "react-ts");
    assert.equal(parseArgs(["my-map", "--force"]).force, true);
  });

  it("accepts both --sdk-version spellings", () => {
    assert.equal(parseArgs(["my-map", "--sdk-version", "0.1.12"]).sdkVersion, "0.1.12");
    assert.equal(parseArgs(["--sdk-version=0.1.13-beta.0", "my-map"]).sdkVersion, "0.1.13-beta.0");
    assert.throws(() => parseArgs(["--sdk-version"]), /requires a version/);
    assert.throws(() => parseArgs(["--sdk-version="]), /requires a version/);
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

  it("follows a promotable channel with a stable certified fallback", () => {
    assert.equal(manifest.sdk.channel, "release-2026.1");
    assert.equal(manifest.sdk.version, CERTIFIED_SDK_VERSION);
    assert.ok(isStableVersion(manifest.sdk.version), `${manifest.sdk.version} must not be a prerelease`);
  });

  it("refuses a prerelease fallback or a channel npm cannot tag", () => {
    const beta = copyPackage((manifest) => {
      manifest.sdk.version = "0.1.11-beta.0";
    });
    assert.throws(() => loadTemplateManifest(beta), /sdk\.version must be a stable release version/);
    const rangeTag = copyPackage((manifest) => {
      manifest.sdk.channel = "2026.1";
    });
    assert.throws(() => loadTemplateManifest(rangeTag), /sdk\.channel must be an npm dist-tag name/);
    const wildcardTag = copyPackage((manifest) => {
      manifest.sdk.channel = "x";
    });
    assert.throws(() => loadTemplateManifest(wildcardTag), /sdk\.channel must be an npm dist-tag name/);
    const missing = copyPackage((manifest) => {
      delete manifest.sdk.channel;
    });
    assert.throws(() => loadTemplateManifest(missing), /sdk\.channel must be a non-empty string/);
  });

  it("accepts only channel names npm can publish as dist-tags", () => {
    for (const name of ["release-2026.1", "latest", "stable", "x-1", "xray", "v-next"]) {
      assert.ok(isChannelName(name), name);
    }
    for (const name of ["2026.1", "x", "X", "x.x.x", "x.1", "v1", "v1.2", "*", "Release", "release_1", "", undefined]) {
      assert.ok(!isChannelName(name), String(name));
    }
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
    assert.equal(projectManifest.dependencies["@honua/sdk-js"], loadTemplateManifest(PACKAGE_ROOT).sdk.version);
    assert.equal(receipt.sdk.source, "pinned");
  });

  it("pins the SDK version the scaffold resolved", () => {
    const cwd = workspace();
    const sdk = { package: "@honua/sdk-js", version: "0.1.99", channel: "release-2026.1", source: "channel" };
    const receipt = scaffoldProject({ templateId: "react-ts", directory: "resolved", cwd, packageRoot: PACKAGE_ROOT, sdk });
    const projectManifest = JSON.parse(fs.readFileSync(path.join(cwd, "resolved/package.json"), "utf8"));
    assert.equal(projectManifest.dependencies["@honua/sdk-js"], "0.1.99");
    assert.deepEqual(receipt.sdk, sdk);
    assert.throws(
      () =>
        scaffoldProject({
          templateId: "react-ts",
          directory: "other",
          cwd,
          packageRoot: PACKAGE_ROOT,
          sdk: { ...sdk, package: "@honua/other" },
        }),
      /is not the manifest's @honua\/sdk-js/,
    );
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
  it("scaffolds and reports next steps", async () => {
    const cwd = workspace();
    const streams = captureStreams();
    const code = await run(["fresh-map"], {
      cwd,
      env: {},
      stdout: streams.stdout,
      stderr: streams.stderr,
      packageRoot: PACKAGE_ROOT,
      fetch: offlineFetch,
    });
    assert.equal(code, 0);
    assert.match(streams.chunks.stdout, /npm run dev/);
    assert.match(streams.chunks.stdout, /the certified version this release of create-honua-app ships/);
    assert.ok(fs.existsSync(path.join(cwd, "fresh-map/src/main.ts")));
  });

  it("pins the promoted channel version a registry reports", async () => {
    const cwd = workspace();
    const streams = captureStreams();
    const requested = [];
    const fetch = registryFetch(
      { "dist-tags": { latest: "0.1.12", "release-2026.1": "0.1.13" }, versions: { "0.1.12": {}, "0.1.13": {} } },
      requested,
    );
    const code = await run(["promoted", "--template", "react-ts"], {
      cwd,
      ...streams,
      packageRoot: PACKAGE_ROOT,
      env: { npm_config_registry: "https://registry.example.test/npm" },
      fetch,
    });
    assert.equal(code, 0, streams.chunks.stderr);
    assert.deepEqual(requested, ["https://registry.example.test/npm/@honua%2Fsdk-js"]);
    const projectManifest = JSON.parse(fs.readFileSync(path.join(cwd, "promoted/package.json"), "utf8"));
    assert.equal(projectManifest.dependencies["@honua/sdk-js"], "0.1.13");
    assert.match(streams.chunks.stdout, /from the promoted release-2026\.1 channel/);
  });

  it("rejects a malformed --sdk-version without writing anything", async () => {
    const cwd = workspace();
    const streams = captureStreams();
    const code = await run(["x", "--sdk-version", "^0.1.12"], {
      cwd,
      ...streams,
      packageRoot: PACKAGE_ROOT,
      env: {},
      fetch: offlineFetch,
    });
    assert.equal(code, 1);
    assert.match(streams.chunks.stderr, /must be an exact version/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it("reports an unknown template without writing anything", async () => {
    const cwd = workspace();
    const streams = captureStreams();
    const code = await run(["x", "--template", "nope"], {
      cwd,
      env: {},
      stdout: streams.stdout,
      stderr: streams.stderr,
      packageRoot: PACKAGE_ROOT,
      fetch: offlineFetch,
    });
    assert.equal(code, 1);
    assert.match(streams.chunks.stderr, /Unknown template/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it("prints help and the version", async () => {
    const streams = captureStreams();
    assert.equal(await run(["--help"], { ...streams, packageRoot: PACKAGE_ROOT }), 0);
    assert.match(streams.chunks.stdout, /--template/);
    assert.match(streams.chunks.stdout, /--sdk-version/);
    const version = captureStreams();
    assert.equal(await run(["--version"], { ...version, packageRoot: PACKAGE_ROOT }), 0);
    assert.match(version.chunks.stdout, /^\d+\.\d+\.\d+/);
  });
});

describe("sdk version resolution", () => {
  const manifest = { sdk: { package: "@honua/sdk-js", channel: "release-2026.1", version: "0.1.12" } };
  const published = { "0.1.11-beta.0": {}, "0.1.12": {}, "0.1.13": {}, "0.1.14-beta.0": {}, "0.2.0": {} };
  const resolveWith = (distTags, options = {}) =>
    resolveSdkVersion({ manifest, env: {}, fetch: registryFetch({ "dist-tags": distTags, versions: published }), ...options });

  it("parses only SemVer 2.0.0 versions", () => {
    for (const valid of ["0.1.12", "0.1.13-beta.0", "1.0.0-alpha-1.x", "1.0.0+build.7", "1.0.0-0.3.7"]) {
      assert.ok(parseVersion(valid), valid);
    }
    for (const invalid of ["0.1.13-..", "0.1.13-alpha..1", "0.1.13-01", "01.1.0", "0.1", "^0.1.12", "0.1.12+", "latest"]) {
      assert.equal(parseVersion(invalid), undefined, invalid);
    }
  });

  it("reads the registry npm installs the SDK from, scope first", () => {
    assert.equal(registryUrl({}), "https://registry.npmjs.org/");
    assert.equal(registryUrl({ npm_config_registry: "https://npm.example.test/sub" }), "https://npm.example.test/sub/");
    const scoped = {
      npm_config_registry: "https://default.example.test/",
      "npm_config_@honua:registry": "https://honua.example.test/npm/",
    };
    assert.equal(registryUrl(scoped, "@honua/sdk-js"), "https://honua.example.test/npm/");
    assert.equal(registryUrl(scoped, "@other/pkg"), "https://default.example.test/");
    assert.throws(() => registryUrl({ npm_config_registry: "file:///tmp/registry" }), /must be an http\(s\) URL/);
    assert.throws(
      () => registryUrl({ npm_config_registry: "not a url s3cret" }),
      (error) => /is not a valid URL/.test(error.message) && !error.message.includes("s3cret"),
    );
    assert.equal(packumentUrl("@honua/sdk-js", "https://npm.example.test/sub/"), "https://npm.example.test/sub/@honua%2Fsdk-js");
    assert.equal(packumentUrl("a/../b?c#d", "https://npm.example.test/"), "https://npm.example.test/a%2F..%2Fb%3Fc%23d");
  });

  it("accepts only stable versions on the pinned SDK line", () => {
    assert.ok(onPinnedLine("0.1.13", "0.1.12"));
    assert.ok(onPinnedLine("0.1.11", "0.1.12"));
    assert.ok(!onPinnedLine("0.1.13-beta.0", "0.1.12"));
    assert.ok(!onPinnedLine("0.2.0", "0.1.12"));
    assert.ok(onPinnedLine("1.4.0", "1.2.3"));
    assert.ok(!onPinnedLine("2.0.0", "1.2.3"));
    assert.ok(!onPinnedLine("latest", "0.1.12"));
  });

  it("follows the promoted channel", async () => {
    const resolved = await resolveWith({ latest: "0.1.12", "release-2026.1": "0.1.13" });
    assert.deepEqual(resolved, { package: "@honua/sdk-js", channel: "release-2026.1", version: "0.1.13", source: "channel" });
  });

  it("falls back to the certified pin for every channel it cannot trust", async () => {
    const cases = [
      [{ latest: "0.1.13" }, /has not been promoted yet/],
      [{ "release-2026.1": "0.1.14-beta.0" }, /not a stable release on this starter's 0\.1\.12 line/],
      [{ "release-2026.1": "0.2.0" }, /not a stable release on this starter's 0\.1\.12 line/],
      [{ "release-2026.1": "0.1.15" }, /which the registry does not list/],
    ];
    for (const [distTags, note] of cases) {
      const resolved = await resolveWith(distTags);
      assert.equal(resolved.version, "0.1.12", JSON.stringify(distTags));
      assert.equal(resolved.source, "pinned");
      assert.match(resolved.note, note);
    }
  });

  it("falls back to the certified pin when the registry fails", async () => {
    const offline = await resolveSdkVersion({ manifest, env: {}, fetch: offlineFetch });
    assert.equal(offline.version, "0.1.12");
    assert.match(offline.note, /could not be reached \(offline\)/);
    const unavailable = await resolveSdkVersion({ manifest, env: {}, fetch: async () => new Response("{}", { status: 503 }) });
    assert.equal(unavailable.version, "0.1.12");
    assert.match(unavailable.note, /returned HTTP 503/);
    const garbage = await resolveSdkVersion({ manifest, env: {}, fetch: async () => new Response("<html>", { status: 200 }) });
    assert.equal(garbage.version, "0.1.12");
    assert.match(garbage.note, /did not return JSON/);
  });

  it("fails when the registry lists neither a usable channel nor the certified fallback", async () => {
    const onlyNextLine = registryFetch({ "dist-tags": { "release-2026.1": "0.2.0" }, versions: { "0.2.0": {} } });
    await assert.rejects(
      resolveSdkVersion({ manifest, env: {}, fetch: onlyNextLine }),
      /does not list the certified @honua\/sdk-js@0\.1\.12, so the app could not install/,
    );
    const unpromoted = registryFetch({ "dist-tags": { latest: "0.2.0" }, versions: { "0.2.0": {} } });
    await assert.rejects(resolveSdkVersion({ manifest, env: {}, fetch: unpromoted }), /has not been promoted yet, and/);
  });

  it("reads through npm's own CLI only when npm launched the scaffold", () => {
    assert.equal(npmCliPath({}), undefined);
    assert.equal(npmCliPath({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }), "/usr/lib/node_modules/npm/bin/npm-cli.js");
    assert.equal(npmCliPath({ npm_execpath: "/usr/lib/node_modules/pnpm/bin/pnpm.cjs" }), undefined);
  });

  it("fails when the configured registry has no SDK package at all", async () => {
    const missing = async () => new Response("{}", { status: 404 });
    await assert.rejects(
      resolveSdkVersion({ manifest, env: {}, fetch: missing }),
      /@honua\/sdk-js is not on the configured npm registry https:\/\/registry\.npmjs\.org\/, so the app could not install/,
    );
    await assert.rejects(resolveSdkVersion({ manifest, env: {}, fetch: missing, override: "0.1.12" }), /is not on the configured/);
  });

  it("queries the scope registry and never prints registry credentials", async () => {
    const env = { "npm_config_@honua:registry": "https://ci-user:s3cret@honua.example.test/npm/" };
    const seen = [];
    const resolved = await resolveSdkVersion({
      manifest,
      env,
      fetch: async (url, init) => {
        seen.push({ url, authorization: init.headers.authorization });
        throw new Error("offline");
      },
    });
    assert.deepEqual(seen, [
      {
        url: "https://honua.example.test/npm/@honua%2Fsdk-js",
        authorization: `Basic ${Buffer.from("ci-user:s3cret").toString("base64")}`,
      },
    ]);
    assert.equal(resolved.version, "0.1.12");
    assert.ok(!resolved.note.includes("s3cret") && !resolved.note.includes("ci-user"), resolved.note);
    await assert.rejects(
      resolveSdkVersion({ manifest, env, fetch: async () => new Response("{}", { status: 404 }) }),
      (error) => !error.message.includes("s3cret") && /honua\.example\.test/.test(error.message),
    );
    await assert.rejects(
      resolveSdkVersion({
        manifest,
        env,
        override: "0.1.99",
        fetch: registryFetch({ "dist-tags": {}, versions: published }),
      }),
      (error) => /is not published on https:\/\/honua\.example\.test\/npm\//.test(error.message) && !error.message.includes("s3cret"),
    );
  });

  it("honours an explicit --sdk-version, including a prerelease", async () => {
    const resolved = await resolveWith({ "release-2026.1": "0.1.13" }, { override: "0.1.11-beta.0" });
    assert.equal(resolved.version, "0.1.11-beta.0");
    assert.equal(resolved.source, "override");
    assert.equal(resolved.note, undefined);
  });

  it("refuses an unpublished or malformed --sdk-version", async () => {
    await assert.rejects(resolveWith({}, { override: "0.9.0" }), /@honua\/sdk-js@0\.9\.0 is not published/);
    await assert.rejects(resolveWith({}, { override: "latest" }), /must be an exact version/);
    await assert.rejects(
      resolveSdkVersion({ manifest, env: {}, fetch: offlineFetch, override: "0.1.13-.." }),
      /must be an exact version/,
    );
  });

  it("keeps an --sdk-version it cannot confirm while offline, and says so", async () => {
    const resolved = await resolveSdkVersion({ manifest, env: {}, fetch: offlineFetch, override: "0.1.13" });
    assert.equal(resolved.version, "0.1.13");
    assert.match(resolved.note, /could not confirm @honua\/sdk-js@0\.1\.13 is published/);
  });
});
