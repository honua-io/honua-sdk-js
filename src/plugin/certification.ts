import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_CAPABILITIES,
  HONUA_PLUGIN_ENVIRONMENTS,
  HONUA_PLUGIN_KINDS,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginCertificationCheck,
  type HonuaPluginCertificationHost,
  type HonuaPluginCertificationReport,
  type HonuaPluginDiagnostic,
  type HonuaPluginKind,
  type HonuaPluginManifest,
  type HonuaPluginManifestValidation,
} from "./types.js";

const CHECKS: readonly HonuaPluginCertificationCheck[] = [
  "manifest",
  "compatibility",
  "environment",
  "capabilities",
  "peers",
  "security-boundary",
];

type JsonObject = Record<string, unknown>;
type ParsedSemver = readonly [number, number, number, readonly (string | number)[]];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const IDENTIFIER = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\.[a-z0-9][a-z0-9._-]*)+)$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const CREDENTIAL_SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function push(
  diagnostics: HonuaPluginDiagnostic[],
  code: string,
  path: string,
  message: string,
  severity: "error" | "warning" = "error",
): void {
  diagnostics.push({ code, severity, path, message });
}

function allowedKeys(
  value: JsonObject | undefined,
  keys: readonly string[],
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): void {
  if (!value) return;
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) push(diagnostics, "MANIFEST_UNKNOWN_FIELD", `${path}/${key}`, "Unknown manifest field.");
  }
}

function requiredObject(value: unknown, path: string, diagnostics: HonuaPluginDiagnostic[]): JsonObject | undefined {
  const parsed = object(value);
  if (!parsed) push(diagnostics, "MANIFEST_TYPE", path, "Expected an object.");
  return parsed;
}

function requiredString(value: unknown, path: string, diagnostics: HonuaPluginDiagnostic[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    push(diagnostics, "MANIFEST_TYPE", path, "Expected a non-empty string.");
    return undefined;
  }
  return value;
}

function stringArray(
  value: unknown,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    push(diagnostics, "MANIFEST_TYPE", path, "Expected an array of non-empty strings.");
    return undefined;
  }
  if (new Set(value).size !== value.length) push(diagnostics, "MANIFEST_DUPLICATE", path, "Values must be unique.");
  return value as string[];
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER.exec(value);
  if (!match) return undefined;
  const core = [match[1], match[2], match[3]].map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined;
  const parts = match[4]?.split(".") ?? [];
  if (parts.some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) return undefined;
  const prerelease = match[4] ? parts.map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part)) : [];
  if (prerelease.some((part) => typeof part === "number" && !Number.isSafeInteger(part))) return undefined;
  return [core[0], core[1], core[2], prerelease];
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] as number) - (right[i] as number);
    if (delta !== 0) return delta;
  }
  const a = left[3];
  const b = right[3];
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    if (typeof av === "number") return -1;
    if (typeof bv === "number") return 1;
    return av.localeCompare(bv);
  }
  return 0;
}

function validateExactSemver(
  value: unknown,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): ParsedSemver | undefined {
  const text = requiredString(value, path, diagnostics);
  if (!text) return undefined;
  const parsed = parseSemver(text);
  if (!parsed) push(diagnostics, "SEMVER_INVALID", path, "Expected an exact semantic version.");
  return parsed;
}

function sortDiagnostics(diagnostics: HonuaPluginDiagnostic[]): readonly HonuaPluginDiagnostic[] {
  return diagnostics.sort(
    (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
  );
}

/** Validate syntax only. This function never resolves or imports the declared entrypoint. */
export function validateHonuaPluginManifest(input: unknown): HonuaPluginManifestValidation {
  const diagnostics: HonuaPluginDiagnostic[] = [];
  const manifest = requiredObject(input, "/", diagnostics);
  allowedKeys(
    manifest,
    [
      "manifestVersion",
      "id",
      "version",
      "kind",
      "package",
      "compatibility",
      "capabilities",
      "peers",
      "requestedGrants",
      "data",
      "lifecycle",
      "support",
    ],
    "",
    diagnostics,
  );
  if (!manifest) return { ok: false, diagnostics: sortDiagnostics(diagnostics) };

  if (manifest.manifestVersion !== HONUA_PLUGIN_MANIFEST_VERSION) {
    push(diagnostics, "MANIFEST_VERSION_UNSUPPORTED", "/manifestVersion", `Expected ${HONUA_PLUGIN_MANIFEST_VERSION}.`);
  }
  const id = requiredString(manifest.id, "/id", diagnostics);
  if (id && !IDENTIFIER.test(id))
    push(diagnostics, "PLUGIN_ID_INVALID", "/id", "Use a lowercase package name or reverse-DNS identifier.");
  validateExactSemver(manifest.version, "/version", diagnostics);

  const kind = requiredString(manifest.kind, "/kind", diagnostics);
  if (kind && !HONUA_PLUGIN_KINDS.includes(kind as HonuaPluginKind)) {
    push(diagnostics, "PLUGIN_KIND_UNKNOWN", "/kind", "Unknown plugin kind.");
  }

  const packageInfo = requiredObject(manifest.package, "/package", diagnostics);
  allowedKeys(packageInfo, ["name", "entrypoint"], "/package", diagnostics);
  const packageName = requiredString(packageInfo?.name, "/package/name", diagnostics);
  if (packageName && !PACKAGE_NAME.test(packageName))
    push(diagnostics, "PACKAGE_NAME_INVALID", "/package/name", "Expected an npm package name.");
  const entrypoint = requiredString(packageInfo?.entrypoint, "/package/entrypoint", diagnostics);
  if (
    entrypoint &&
    (!entrypoint.startsWith("./") ||
      entrypoint.includes("\\") ||
      entrypoint.split("/").includes("..") ||
      /^\.\/\//.test(entrypoint))
  ) {
    push(
      diagnostics,
      "ENTRYPOINT_UNSAFE",
      "/package/entrypoint",
      "Entrypoint must be a package-relative path without traversal.",
    );
  }

  const compatibility = requiredObject(manifest.compatibility, "/compatibility", diagnostics);
  allowedKeys(
    compatibility,
    ["pluginApi", "minimumSdk", "maximumSdkExclusive", "environments"],
    "/compatibility",
    diagnostics,
  );
  if (compatibility?.pluginApi !== HONUA_PLUGIN_API_VERSION) {
    push(diagnostics, "PLUGIN_API_UNSUPPORTED", "/compatibility/pluginApi", `Expected ${HONUA_PLUGIN_API_VERSION}.`);
  }
  const minimum = validateExactSemver(compatibility?.minimumSdk, "/compatibility/minimumSdk", diagnostics);
  const maximum =
    compatibility?.maximumSdkExclusive === undefined
      ? undefined
      : validateExactSemver(compatibility.maximumSdkExclusive, "/compatibility/maximumSdkExclusive", diagnostics);
  if (minimum && maximum && compareSemver(minimum, maximum) >= 0) {
    push(diagnostics, "SDK_RANGE_EMPTY", "/compatibility/maximumSdkExclusive", "Must be greater than minimumSdk.");
  }
  const environments = stringArray(compatibility?.environments, "/compatibility/environments", diagnostics);
  if (environments?.length === 0)
    push(diagnostics, "ENVIRONMENT_EMPTY", "/compatibility/environments", "Declare at least one environment.");
  for (const [index, environment] of (environments ?? []).entries()) {
    if (!HONUA_PLUGIN_ENVIRONMENTS.includes(environment as never)) {
      push(diagnostics, "ENVIRONMENT_UNKNOWN", `/compatibility/environments/${index}`, "Unknown environment.");
    }
  }

  const capabilities = stringArray(manifest.capabilities, "/capabilities", diagnostics);
  if (capabilities?.length === 0)
    push(diagnostics, "CAPABILITY_EMPTY", "/capabilities", "Declare at least one capability.");
  if (kind && HONUA_PLUGIN_KINDS.includes(kind as HonuaPluginKind)) {
    const supported = new Set(HONUA_PLUGIN_CAPABILITIES[kind as HonuaPluginKind]);
    for (const [index, capability] of (capabilities ?? []).entries()) {
      if (!supported.has(capability as never)) {
        push(
          diagnostics,
          "CAPABILITY_KIND_MISMATCH",
          `/capabilities/${index}`,
          `Capability is not valid for kind ${kind}.`,
        );
      }
    }
  }

  if (manifest.peers !== undefined && !Array.isArray(manifest.peers)) {
    push(diagnostics, "MANIFEST_TYPE", "/peers", "Expected an array.");
  }
  const peerNames = new Set<string>();
  for (const [index, rawPeer] of (Array.isArray(manifest.peers) ? manifest.peers : []).entries()) {
    const path = `/peers/${index}`;
    const peer = requiredObject(rawPeer, path, diagnostics);
    allowedKeys(peer, ["name", "minimumVersion", "optional"], path, diagnostics);
    const name = requiredString(peer?.name, `${path}/name`, diagnostics);
    if (name && !PACKAGE_NAME.test(name))
      push(diagnostics, "PACKAGE_NAME_INVALID", `${path}/name`, "Expected an npm package name.");
    if (name && peerNames.has(name)) push(diagnostics, "PEER_DUPLICATE", `${path}/name`, "Peer names must be unique.");
    if (name) peerNames.add(name);
    validateExactSemver(peer?.minimumVersion, `${path}/minimumVersion`, diagnostics);
    if (peer?.optional !== undefined && typeof peer.optional !== "boolean")
      push(diagnostics, "MANIFEST_TYPE", `${path}/optional`, "Expected a boolean.");
  }

  const grants = requiredObject(manifest.requestedGrants, "/requestedGrants", diagnostics);
  allowedKeys(grants, ["networkOrigins", "credentialScopes", "storage", "mutation"], "/requestedGrants", diagnostics);
  const origins =
    grants?.networkOrigins === undefined
      ? []
      : stringArray(grants.networkOrigins, "/requestedGrants/networkOrigins", diagnostics);
  for (const [index, origin] of (origins ?? []).entries()) {
    let valid = false;
    try {
      const parsed = new URL(origin);
      valid = parsed.origin === origin && parsed.protocol === "https:" && !parsed.hostname.includes("*");
    } catch {
      valid = false;
    }
    if (!valid)
      push(
        diagnostics,
        "NETWORK_ORIGIN_UNSAFE",
        `/requestedGrants/networkOrigins/${index}`,
        "Use an exact HTTPS origin; wildcards, paths, and credentials are forbidden.",
      );
  }
  const scopes =
    grants?.credentialScopes === undefined
      ? []
      : stringArray(grants.credentialScopes, "/requestedGrants/credentialScopes", diagnostics);
  for (const [index, scope] of (scopes ?? []).entries()) {
    if (!CREDENTIAL_SCOPE.test(scope))
      push(
        diagnostics,
        "CREDENTIAL_SCOPE_INVALID",
        `/requestedGrants/credentialScopes/${index}`,
        "Invalid credential scope identifier.",
      );
  }
  if (grants?.storage !== undefined && !["none", "scoped"].includes(grants.storage as string))
    push(diagnostics, "MANIFEST_ENUM", "/requestedGrants/storage", "Expected none or scoped.");
  if (grants?.mutation !== undefined && typeof grants.mutation !== "boolean")
    push(diagnostics, "MANIFEST_TYPE", "/requestedGrants/mutation", "Expected a boolean.");

  const data = requiredObject(manifest.data, "/data", diagnostics);
  allowedKeys(
    data,
    ["cache", "freshness", "authentication", "provenance", "mutation", "realtime"],
    "/data",
    diagnostics,
  );
  validateEnum(data?.cache, ["none", "memory", "persistent"], "/data/cache", diagnostics);
  validateEnum(data?.freshness, ["snapshot", "ttl", "realtime"], "/data/freshness", diagnostics);
  validateEnum(data?.authentication, ["none", "application-grant"], "/data/authentication", diagnostics);
  validateEnum(data?.provenance, ["preserved", "derived"], "/data/provenance", diagnostics);
  validateEnum(data?.mutation, ["none", "explicit"], "/data/mutation", diagnostics);
  validateEnum(data?.realtime, ["none", "polling", "push"], "/data/realtime", diagnostics);
  if (data?.mutation === "explicit" && grants?.mutation !== true)
    push(
      diagnostics,
      "MUTATION_GRANT_REQUIRED",
      "/requestedGrants/mutation",
      "Explicit mutation semantics require a mutation grant request.",
    );
  if (data?.authentication === "application-grant" && (scopes?.length ?? 0) === 0)
    push(
      diagnostics,
      "CREDENTIAL_SCOPE_REQUIRED",
      "/requestedGrants/credentialScopes",
      "Authenticated plugins must name at least one credential scope.",
    );
  if (data?.cache === "persistent" && grants?.storage !== "scoped")
    push(
      diagnostics,
      "STORAGE_GRANT_REQUIRED",
      "/requestedGrants/storage",
      "Persistent caching requires scoped storage.",
    );

  const lifecycle = requiredObject(manifest.lifecycle, "/lifecycle", diagnostics);
  allowedKeys(lifecycle, ["initialization", "disposal"], "/lifecycle", diagnostics);
  validateEnum(lifecycle?.initialization, ["explicit"], "/lifecycle/initialization", diagnostics);
  validateEnum(lifecycle?.disposal, ["none", "required"], "/lifecycle/disposal", diagnostics);
  validateEnum(manifest.support, ["community", "partner", "honua"], "/support", diagnostics);

  const sorted = sortDiagnostics(diagnostics);
  return sorted.some((item) => item.severity === "error")
    ? { ok: false, diagnostics: sorted }
    : { ok: true, manifest: input as HonuaPluginManifest, diagnostics: sorted };
}

function validateEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): void {
  if (typeof value !== "string" || !allowed.includes(value))
    push(diagnostics, "MANIFEST_ENUM", path, `Expected one of: ${allowed.join(", ")}.`);
}

/**
 * Certify a manifest against one explicit host snapshot.
 *
 * Certification is intentionally data-only: no entrypoint is imported and no
 * plugin hook runs. Runtime conformance, cancellation, cleanup and performance
 * suites remain a separate phase of issue #392.
 */
export function certifyHonuaPluginManifest(
  input: unknown,
  host: HonuaPluginCertificationHost,
): HonuaPluginCertificationReport {
  const validation = validateHonuaPluginManifest(input);
  const diagnostics = [...validation.diagnostics];
  const manifest = validation.manifest;
  const hostVersion = parseSemver(host.sdkVersion);
  if (!hostVersion)
    push(diagnostics, "HOST_SDK_VERSION_INVALID", "/host/sdkVersion", "Host SDK version must be exact SemVer.");

  if (manifest) {
    if (manifest.compatibility.pluginApi !== host.pluginApi)
      push(
        diagnostics,
        "HOST_PLUGIN_API_INCOMPATIBLE",
        "/compatibility/pluginApi",
        "Plugin API does not match the host.",
      );
    const minimum = parseSemver(manifest.compatibility.minimumSdk);
    const maximum = manifest.compatibility.maximumSdkExclusive
      ? parseSemver(manifest.compatibility.maximumSdkExclusive)
      : undefined;
    if (hostVersion && minimum && compareSemver(hostVersion, minimum) < 0)
      push(diagnostics, "HOST_SDK_TOO_OLD", "/compatibility/minimumSdk", "Host SDK is older than the plugin minimum.");
    if (hostVersion && maximum && compareSemver(hostVersion, maximum) >= 0)
      push(
        diagnostics,
        "HOST_SDK_TOO_NEW",
        "/compatibility/maximumSdkExclusive",
        "Host SDK is outside the plugin range.",
      );
    if (!manifest.compatibility.environments.includes(host.environment))
      push(
        diagnostics,
        "HOST_ENVIRONMENT_UNSUPPORTED",
        "/compatibility/environments",
        "Plugin does not declare the host environment.",
      );

    for (const [index, peer] of (manifest.peers ?? []).entries()) {
      const installed = host.peers?.[peer.name];
      if (!installed) {
        push(
          diagnostics,
          peer.optional ? "OPTIONAL_PEER_MISSING" : "REQUIRED_PEER_MISSING",
          `/peers/${index}`,
          `Peer ${peer.name} is not installed.`,
          peer.optional ? "warning" : "error",
        );
        continue;
      }
      const installedVersion = parseSemver(installed);
      const minimumVersion = parseSemver(peer.minimumVersion);
      if (!installedVersion)
        push(
          diagnostics,
          "HOST_PEER_VERSION_INVALID",
          `/host/peers/${peer.name}`,
          "Installed peer version must be exact SemVer.",
        );
      else if (minimumVersion && compareSemver(installedVersion, minimumVersion) < 0)
        push(diagnostics, "HOST_PEER_TOO_OLD", `/peers/${index}/minimumVersion`, `Installed ${peer.name} is too old.`);
    }

    const grantedOrigins = new Set(host.grants?.networkOrigins ?? []);
    for (const [index, origin] of (manifest.requestedGrants.networkOrigins ?? []).entries()) {
      if (!grantedOrigins.has(origin))
        push(
          diagnostics,
          "NETWORK_GRANT_MISSING",
          `/requestedGrants/networkOrigins/${index}`,
          "Application did not grant this origin.",
        );
    }
    const grantedScopes = new Set(host.grants?.credentialScopes ?? []);
    for (const [index, scope] of (manifest.requestedGrants.credentialScopes ?? []).entries()) {
      if (!grantedScopes.has(scope))
        push(
          diagnostics,
          "CREDENTIAL_GRANT_MISSING",
          `/requestedGrants/credentialScopes/${index}`,
          "Application did not grant this credential scope.",
        );
    }
    if (manifest.requestedGrants.storage === "scoped" && host.grants?.storage !== "scoped")
      push(
        diagnostics,
        "STORAGE_GRANT_MISSING",
        "/requestedGrants/storage",
        "Application did not grant scoped storage.",
      );
    if (manifest.requestedGrants.mutation === true && host.grants?.mutation !== true)
      push(
        diagnostics,
        "MUTATION_GRANT_MISSING",
        "/requestedGrants/mutation",
        "Application did not grant mutation authority.",
      );
  }

  const sorted = sortDiagnostics(diagnostics);
  const errorCodes = new Set(sorted.filter((item) => item.severity === "error").map((item) => item.code));
  const codesFor = (check: HonuaPluginCertificationCheck): readonly string[] =>
    sorted.filter((item) => diagnosticCheck(item.code) === check).map((item) => item.code);

  return {
    reportVersion: 1,
    manifestVersion:
      object(input) && typeof object(input)?.manifestVersion === "number"
        ? (object(input)?.manifestVersion as number)
        : null,
    plugin: manifest ? { id: manifest.id, version: manifest.version, kind: manifest.kind } : null,
    status: errorCodes.size === 0 ? "certified" : "rejected",
    host: { pluginApi: host.pluginApi, sdkVersion: host.sdkVersion, environment: host.environment },
    checks: CHECKS.map((check) => {
      const diagnosticCodes = codesFor(check);
      return {
        check,
        status: diagnosticCodes.some((code) => errorCodes.has(code)) ? "failed" : "passed",
        diagnosticCodes,
      };
    }),
    diagnostics: sorted,
  };
}

function diagnosticCheck(code: string): HonuaPluginCertificationCheck {
  if (code.includes("CAPABILITY")) return "capabilities";
  if (code.includes("ENVIRONMENT")) return "environment";
  if (code.includes("PEER")) return "peers";
  if (
    code.includes("GRANT") ||
    code.includes("ORIGIN") ||
    code.includes("CREDENTIAL") ||
    code.includes("STORAGE") ||
    code.includes("MUTATION")
  )
    return "security-boundary";
  if (code.includes("SDK") || code.includes("PLUGIN_API") || code.includes("SEMVER")) return "compatibility";
  return "manifest";
}
