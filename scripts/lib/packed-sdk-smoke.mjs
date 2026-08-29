import fs from "node:fs";
import path from "node:path";

export function supportedEntrypoints(surface) {
  return surface.entrypoints.filter(
    (entrypoint) => entrypoint.tier === "stable" || entrypoint.tier === "experimental",
  );
}

export function packageSpecifier(packageName, subpath) {
  return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
}

function exportTarget(exported, condition) {
  if (condition === "default" && typeof exported === "string") return exported;
  return exported && typeof exported === "object" ? exported[condition] : undefined;
}

function escapesPackage(relativePath) {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

export function validateInstalledManifest({ packageRoot, packageJson, entrypoints }) {
  const failures = [];

  for (const entrypoint of entrypoints) {
    const exported = packageJson.exports?.[entrypoint.subpath];
    for (const condition of ["default", "types"]) {
      const target = exportTarget(exported, condition);
      if (typeof target !== "string") {
        failures.push(`${entrypoint.subpath} installed export has no ${condition} target`);
        continue;
      }
      const resolved = path.resolve(packageRoot, target);
      const relative = path.relative(packageRoot, resolved);
      if (escapesPackage(relative)) {
        failures.push(
          `${entrypoint.subpath} installed ${condition} target escapes the package: ${target}`,
        );
      } else if (!fs.existsSync(resolved)) {
        failures.push(`${entrypoint.subpath} installed ${condition} target is missing: ${target}`);
      }
    }
  }

  const binTarget = packageJson.bin?.honua;
  if (typeof binTarget !== "string") {
    failures.push('installed package has no "honua" bin target');
  } else {
    const resolved = path.resolve(packageRoot, binTarget);
    const relative = path.relative(packageRoot, resolved);
    if (escapesPackage(relative)) {
      failures.push(`installed honua bin target escapes the package: ${binTarget}`);
    } else if (!fs.existsSync(resolved)) {
      failures.push(`installed honua bin target is missing: ${binTarget}`);
    }
  }

  return failures;
}

export function runtimeSmokeSource(packageName, entrypoints) {
  const specifiers = entrypoints.map((entrypoint) =>
    packageSpecifier(packageName, entrypoint.subpath),
  );
  return `${specifiers
    .map(
      (specifier) =>
        `try {\n  await import(${JSON.stringify(specifier)});\n  process.stdout.write(${JSON.stringify(
          `${specifier}=ok\n`,
        )});\n} catch (error) {\n  process.stderr.write(${JSON.stringify(
          `${specifier} installed runtime import failed: `,
        )} + (error instanceof Error ? error.stack ?? error.message : String(error)) + "\\n");\n  process.exitCode = 1;\n}`,
    )
    .join("\n")}
`;
}

export function typeSmokeSource(packageName, entrypoints) {
  return `${entrypoints
    .map((entrypoint, index) => {
      const specifier = packageSpecifier(packageName, entrypoint.subpath);
      return `import type * as Entrypoint${index} from ${JSON.stringify(specifier)};\nexport type Entrypoint${index}Surface = typeof Entrypoint${index};`;
    })
    .join("\n")}
`;
}

/**
 * The seven `honua admin` groups the honua-release#123 terminal journey drives.
 */
export const ADMIN_JOURNEY_GROUPS = Object.freeze([
  "connect",
  "import",
  "publish",
  "configure",
  "secure",
  "release",
  "operate",
]);

/**
 * Admin operations proven against the packed CLI and the packed request compiler.
 *
 * honua-release#205 certified a pinned artifact that shipped no `honua admin` verb at all,
 * which stalled honua-release#123 stages 2, 3 and 8 regardless of server readiness. Repository
 * source carried the command throughout, so only a check against packed bytes can catch a
 * recurrence.
 *
 * `stage` names the honua-release#123 journey stage an entry proves; entries with a null stage
 * exist so every one of the seven groups resolves a real operation. Help text alone cannot
 * certify a group — stale help would keep advertising a group whose operations no longer
 * resolve.
 *
 * `expectedPath` is the fully interpolated path the packed client must produce for
 * `pathParams`. Asserting it (rather than the descriptor the CLI echoes back under
 * `--dry-run`) is what makes placeholder drift fail: if `{id}` were renamed, the supplied
 * parameter would no longer interpolate and the probe would fail instead of quietly passing.
 */
export const ADMIN_JOURNEY_OPERATIONS = Object.freeze(
  [
    // Stage 2 — verify the installer-provisioned credential.
    { stage: 2, group: "secure", operationId: "listAdminApiKeys", expectedPath: "/api-keys" },
    {
      stage: 2,
      group: "secure",
      operationId: "getAdminApiKeyEffectivePermissions",
      pathParams: { id: "packed-key" },
      expectedPath: "/api-keys/packed-key/effective-permissions",
    },
    // Stage 3 — connection create/test.
    {
      stage: 3,
      group: "connect",
      operationId: "createConnection",
      body: '{"name":"packed"}',
      expectedPath: "/connections",
    },
    {
      stage: 3,
      group: "connect",
      operationId: "testConnection",
      pathParams: { id: "packed-connection" },
      expectedPath: "/connections/packed-connection/test",
    },
    // Stage 8 — the literal command shape from honua-release#123: a second human principal
    // approving a proposal through a named profile.
    {
      stage: 8,
      group: "operate",
      operationId: "approveOperationProposal",
      pathParams: { id: "packed-proposal" },
      extraArgs: ["--profile", "approver", "--yes"],
      expectedPath: "/proposals/packed-proposal/approve",
    },
    // Remaining groups, so a group that stops resolving fails the gate.
    { stage: null, group: "import", operationId: "getImportFormats", expectedPath: "/import/formats" },
    {
      stage: null,
      group: "publish",
      operationId: "getAdminLayerStyle",
      pathParams: { layerId: "packed-layer" },
      expectedPath: "/metadata/layers/packed-layer/style",
    },
    { stage: null, group: "configure", operationId: "listServices", expectedPath: "/services" },
    {
      stage: null,
      group: "release",
      operationId: "getDeployOperation",
      pathParams: { operationId: "packed-operation" },
      expectedPath: "/deploy/operations/packed-operation",
    },
  ].map((entry) =>
    Object.freeze({
      ...entry,
      pathParams: Object.freeze({ ...(entry.pathParams ?? {}) }),
      extraArgs: Object.freeze([...(entry.extraArgs ?? [])]),
    }),
  ),
);

/**
 * CLI arguments for one journey entry, without the trailing mode flag.
 */
export function adminJourneyCliArgs(entry) {
  const args = ["admin", entry.group, entry.operationId];
  for (const [name, value] of Object.entries(entry.pathParams)) {
    args.push("--path", `${name}=${value}`);
  }
  if (entry.body !== undefined) args.push("--body", entry.body);
  args.push(...entry.extraArgs);
  return args;
}

/**
 * Probe source that drives each journey operation through the packed `HonuaAdminClient`.
 *
 * The CLI's `--dry-run` returns the operation descriptor before the client interpolates the
 * path, so it cannot see placeholder drift. This runs the real request compiler from the
 * installed package with a capturing `fetchFn`, so the assertion is on the request that would
 * actually be sent. No network: the injected fetch never forwards.
 */
export function adminRequestProbeSource(packageName, operations) {
  return `import { HonuaAdminClient } from ${JSON.stringify(`${packageName}/control-plane`)};

const operations = ${JSON.stringify(operations, null, 2)};
let failures = 0;

for (const entry of operations) {
  let captured;
  const client = new HonuaAdminClient({
    baseUrl: "http://127.0.0.1:9",
    adminKey: "packed-probe",
    fetchFn: (url) => {
      captured = new URL(url);
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    },
  });
  try {
    await client.call(entry.operationId, { path: entry.pathParams, body: entry.body });
  } catch (error) {
    process.stderr.write(\`\${entry.operationId} packed request compilation failed: \${error?.message ?? error}\\n\`);
    failures += 1;
    continue;
  }
  if (!captured) {
    process.stderr.write(\`\${entry.operationId} never reached the request compiler\\n\`);
    failures += 1;
    continue;
  }
  if (/[{}]/.test(captured.pathname)) {
    process.stderr.write(\`\${entry.operationId} left an uninterpolated placeholder: \${captured.pathname}\\n\`);
    failures += 1;
    continue;
  }
  if (!captured.pathname.endsWith(entry.expectedPath)) {
    process.stderr.write(
      \`\${entry.operationId} compiled \${captured.pathname}, expected it to end with \${entry.expectedPath}\\n\`,
    );
    failures += 1;
    continue;
  }
  process.stdout.write(\`\${entry.operationId}=\${entry.expectedPath}\\n\`);
}

if (failures > 0) {
  process.stderr.write(\`\${failures} packed admin request probe(s) failed\\n\`);
  process.exitCode = 1;
}
`;
}
