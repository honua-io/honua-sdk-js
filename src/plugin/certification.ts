import { canonicalStringify, sha256 } from "../query-planner/canonical.js";
import { deepFreeze, snapshotPlainJson } from "./plain-json.js";
import { type ParsedSemver, compareSemver, parseSemver } from "./semver.js";
import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_CAPABILITIES,
  HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS,
  HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION,
  HONUA_PLUGIN_ENVIRONMENTS,
  HONUA_PLUGIN_KINDS,
  HONUA_PLUGIN_MANIFEST_VERSION,
  HONUA_PLUGIN_SUPPORT_STATES,
  type HonuaPluginCertificationCheck,
  type HonuaPluginCertificationHost,
  type HonuaPluginCertificationReport,
  type HonuaPluginDiagnostic,
  type HonuaPluginHostValidation,
  type HonuaPluginJsonValue,
  type HonuaPluginKind,
  type HonuaPluginManifest,
  type HonuaPluginManifestValidation,
  type HonuaPluginReportVerification,
} from "./types.js";

const CHECKS: readonly HonuaPluginCertificationCheck[] = [
  "manifest",
  "compatibility",
  "environment",
  "capabilities",
  "peers",
  "security-boundary",
  "support",
];

type JsonObject = Readonly<Record<string, HonuaPluginJsonValue>>;

function object(value: HonuaPluginJsonValue | undefined): JsonObject | undefined {
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
    if (!allowed.has(key))
      push(diagnostics, "MANIFEST_UNKNOWN_FIELD", `${path}/${escapePointer(key)}`, "Unknown field.");
  }
}

function requiredObject(
  value: HonuaPluginJsonValue | undefined,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): JsonObject | undefined {
  const parsed = object(value);
  if (!parsed) push(diagnostics, "MANIFEST_TYPE", path, "Expected an object.");
  return parsed;
}

function requiredString(
  value: HonuaPluginJsonValue | undefined,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    push(diagnostics, "MANIFEST_TYPE", path, "Expected a non-empty string.");
    return undefined;
  }
  return value;
}

function stringArray(
  value: HonuaPluginJsonValue | undefined,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    push(diagnostics, "MANIFEST_TYPE", path, "Expected an array of non-empty strings.");
    return undefined;
  }
  const strings = value as readonly string[];
  if (new Set(strings).size !== strings.length) push(diagnostics, "MANIFEST_DUPLICATE", path, "Values must be unique.");
  return strings;
}

function validateExactSemver(
  value: HonuaPluginJsonValue | undefined,
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
    (a, b) => asciiCompare(a.path, b.path) || asciiCompare(a.code, b.code) || asciiCompare(a.message, b.message),
  );
}

/** Validate and normalize untrusted manifest JSON text. No entrypoint is imported. */
export function validateHonuaPluginManifest(input: string): HonuaPluginManifestValidation {
  const inert = snapshotPlainJson(input, "/");
  if (!inert.ok || inert.value === undefined) return { ok: false, diagnostics: inert.diagnostics };
  return validateManifestSnapshot(inert.value);
}

function validateManifestSnapshot(snapshot: HonuaPluginJsonValue): HonuaPluginManifestValidation {
  const diagnostics: HonuaPluginDiagnostic[] = [];
  const manifest = requiredObject(snapshot, "/", diagnostics);
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
      "supportStatus",
    ],
    "",
    diagnostics,
  );
  if (!manifest) return { ok: false, snapshot, diagnostics: sortDiagnostics(diagnostics) };

  if (manifest.manifestVersion !== HONUA_PLUGIN_MANIFEST_VERSION) {
    push(diagnostics, "MANIFEST_VERSION_UNSUPPORTED", "/manifestVersion", `Expected ${HONUA_PLUGIN_MANIFEST_VERSION}.`);
  }
  const id = requiredString(manifest.id, "/id", diagnostics);
  if (id && !validPluginId(id))
    push(diagnostics, "PLUGIN_ID_INVALID", "/id", "Use a lowercase package name or reverse-DNS identifier.");
  validateExactSemver(manifest.version, "/version", diagnostics);

  const kind = requiredString(manifest.kind, "/kind", diagnostics);
  const knownKind = kind !== undefined && HONUA_PLUGIN_KINDS.includes(kind as HonuaPluginKind);
  if (kind && !knownKind) push(diagnostics, "PLUGIN_KIND_UNKNOWN", "/kind", "Unknown plugin kind.");

  const packageInfo = requiredObject(manifest.package, "/package", diagnostics);
  allowedKeys(packageInfo, ["name", "entrypoint"], "/package", diagnostics);
  const packageName = requiredString(packageInfo?.name, "/package/name", diagnostics);
  if (packageName && !validPackageName(packageName))
    push(diagnostics, "PACKAGE_NAME_INVALID", "/package/name", "Expected an npm package name.");
  const entrypoint = requiredString(packageInfo?.entrypoint, "/package/entrypoint", diagnostics);
  const normalizedEntrypoint = entrypoint ? normalizeEntrypoint(entrypoint, diagnostics) : undefined;

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
  const validCapabilities: string[] = [];
  if (knownKind) {
    const supported = new Set(HONUA_PLUGIN_CAPABILITIES[kind as HonuaPluginKind]);
    for (const [index, capability] of (capabilities ?? []).entries()) {
      if (!supported.has(capability as never)) {
        push(
          diagnostics,
          "CAPABILITY_KIND_MISMATCH",
          `/capabilities/${index}`,
          `Capability is not valid for kind ${kind}.`,
        );
      } else validCapabilities.push(capability);
    }
  }

  const peers = validatePeers(manifest.peers, diagnostics);
  const grants = validateGrants(manifest.requestedGrants, "/requestedGrants", diagnostics, true);
  const data = validateData(manifest.data, diagnostics);
  const lifecycle = requiredObject(manifest.lifecycle, "/lifecycle", diagnostics);
  allowedKeys(lifecycle, ["initialization", "disposal"], "/lifecycle", diagnostics);
  validateEnum(lifecycle?.initialization, ["explicit"], "/lifecycle/initialization", diagnostics);
  validateEnum(lifecycle?.disposal, ["none", "required"], "/lifecycle/disposal", diagnostics);
  validateEnum(manifest.support, ["community", "partner", "honua"], "/support", diagnostics);
  const supportStatus = validateSupportStatus(manifest.supportStatus, diagnostics);

  if (data?.mutation === "explicit" && grants?.mutation !== true) {
    push(
      diagnostics,
      "MUTATION_GRANT_REQUIRED",
      "/requestedGrants/mutation",
      "Explicit mutation semantics require a mutation grant request.",
    );
  }
  if (data?.authentication === "application-grant" && (grants?.credentialScopes.length ?? 0) === 0) {
    push(
      diagnostics,
      "CREDENTIAL_SCOPE_REQUIRED",
      "/requestedGrants/credentialScopes",
      "Authenticated plugins must name at least one credential scope.",
    );
  }
  if (data?.cache === "persistent" && grants?.storage !== "scoped") {
    push(
      diagnostics,
      "STORAGE_GRANT_REQUIRED",
      "/requestedGrants/storage",
      "Persistent caching requires scoped storage.",
    );
  }
  if (knownKind && data && grants) {
    enforceCapabilityAuthorities(kind as HonuaPluginKind, validCapabilities, data, grants, diagnostics);
  }

  const sorted = sortDiagnostics(diagnostics);
  if (sorted.some((item) => item.severity === "error")) return { ok: false, snapshot, diagnostics: sorted };

  const normalized = normalizeManifest({
    manifest,
    packageInfo: packageInfo as JsonObject,
    entrypoint: normalizedEntrypoint as string,
    compatibility: compatibility as JsonObject,
    environments: environments as readonly string[],
    capabilities: validCapabilities,
    peers,
    grants: grants as NormalizedGrants,
    data: data as JsonObject,
    lifecycle: lifecycle as JsonObject,
    supportStatus,
  });
  return {
    ok: true,
    manifest: normalized as unknown as HonuaPluginManifest,
    snapshot: normalized,
    diagnostics: sorted,
  };
}

interface NormalizedGrants {
  readonly networkOrigins: readonly string[];
  readonly credentialScopes: readonly string[];
  readonly storage?: "none" | "scoped";
  readonly mutation?: boolean;
}

function validateGrants(
  value: HonuaPluginJsonValue | undefined,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
  required: boolean,
): NormalizedGrants | undefined {
  if (value === undefined && !required) return { networkOrigins: [], credentialScopes: [] };
  const grants = requiredObject(value, path, diagnostics);
  allowedKeys(grants, ["networkOrigins", "credentialScopes", "storage", "mutation"], path, diagnostics);
  const origins =
    grants?.networkOrigins === undefined
      ? []
      : stringArray(grants.networkOrigins, `${path}/networkOrigins`, diagnostics);
  for (const [index, origin] of (origins ?? []).entries())
    validateOrigin(origin, `${path}/networkOrigins/${index}`, diagnostics);
  const scopes =
    grants?.credentialScopes === undefined
      ? []
      : stringArray(grants.credentialScopes, `${path}/credentialScopes`, diagnostics);
  for (const [index, scope] of (scopes ?? []).entries()) {
    if (!validCredentialScope(scope))
      push(
        diagnostics,
        "CREDENTIAL_SCOPE_INVALID",
        `${path}/credentialScopes/${index}`,
        "Invalid credential scope identifier.",
      );
  }
  if (grants?.storage !== undefined && grants.storage !== "none" && grants.storage !== "scoped") {
    push(diagnostics, "MANIFEST_ENUM", `${path}/storage`, "Expected none or scoped.");
  }
  if (grants?.mutation !== undefined && typeof grants.mutation !== "boolean") {
    push(diagnostics, "MANIFEST_TYPE", `${path}/mutation`, "Expected a boolean.");
  }
  return {
    networkOrigins: [...(origins ?? [])].sort(asciiCompare),
    credentialScopes: [...(scopes ?? [])].sort(asciiCompare),
    storage: grants?.storage === "none" || grants?.storage === "scoped" ? grants.storage : undefined,
    mutation: typeof grants?.mutation === "boolean" ? grants.mutation : undefined,
  };
}

function validateOrigin(origin: string, path: string, diagnostics: HonuaPluginDiagnostic[]): void {
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
      path,
      "Use an exact HTTPS origin; wildcards, paths, and credentials are forbidden.",
    );
}

function validatePeers(
  value: HonuaPluginJsonValue | undefined,
  diagnostics: HonuaPluginDiagnostic[],
): readonly JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    push(diagnostics, "MANIFEST_TYPE", "/peers", "Expected an array.");
    return [];
  }
  const peers: JsonObject[] = [];
  const names = new Set<string>();
  for (const [index, rawPeer] of value.entries()) {
    const path = `/peers/${index}`;
    const peer = requiredObject(rawPeer, path, diagnostics);
    allowedKeys(peer, ["name", "minimumVersion", "optional"], path, diagnostics);
    const name = requiredString(peer?.name, `${path}/name`, diagnostics);
    if (name && !validPackageName(name))
      push(diagnostics, "PACKAGE_NAME_INVALID", `${path}/name`, "Expected an npm package name.");
    if (name && names.has(name)) push(diagnostics, "PEER_DUPLICATE", `${path}/name`, "Peer names must be unique.");
    if (name) names.add(name);
    validateExactSemver(peer?.minimumVersion, `${path}/minimumVersion`, diagnostics);
    if (peer?.optional !== undefined && typeof peer.optional !== "boolean")
      push(diagnostics, "MANIFEST_TYPE", `${path}/optional`, "Expected a boolean.");
    if (peer) peers.push(peer);
  }
  return peers.sort((left, right) =>
    asciiCompare(typeof left.name === "string" ? left.name : "", typeof right.name === "string" ? right.name : ""),
  );
}

function validateSupportStatus(
  value: HonuaPluginJsonValue | undefined,
  diagnostics: HonuaPluginDiagnostic[],
): JsonObject | undefined {
  if (value === undefined) return undefined;
  const status = requiredObject(value, "/supportStatus", diagnostics);
  allowedKeys(status, ["state", "since", "removedIn", "replacement"], "/supportStatus", diagnostics);
  validateEnum(status?.state, HONUA_PLUGIN_SUPPORT_STATES, "/supportStatus/state", diagnostics);
  if (status?.since !== undefined) validateExactSemver(status.since, "/supportStatus/since", diagnostics);
  if (status?.removedIn !== undefined) validateExactSemver(status.removedIn, "/supportStatus/removedIn", diagnostics);
  const replacement =
    status?.replacement === undefined
      ? undefined
      : requiredString(status.replacement, "/supportStatus/replacement", diagnostics);
  if (replacement !== undefined && !validPluginId(replacement)) {
    push(
      diagnostics,
      "SUPPORT_REPLACEMENT_INVALID",
      "/supportStatus/replacement",
      "Replacement must be a valid plugin id.",
    );
  }
  if (status?.state === "deprecated" && status.removedIn === undefined && status.replacement === undefined) {
    push(
      diagnostics,
      "SUPPORT_DEPRECATION_INCOMPLETE",
      "/supportStatus",
      "A deprecated plugin must declare a removedIn version or a replacement id.",
    );
  }
  return status;
}

function validateData(
  value: HonuaPluginJsonValue | undefined,
  diagnostics: HonuaPluginDiagnostic[],
): JsonObject | undefined {
  const data = requiredObject(value, "/data", diagnostics);
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
  return data;
}

function enforceCapabilityAuthorities(
  kind: HonuaPluginKind,
  capabilities: readonly string[],
  data: JsonObject,
  grants: NormalizedGrants,
  diagnostics: HonuaPluginDiagnostic[],
): void {
  for (const [index, capability] of capabilities.entries()) {
    const requirement = (
      HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS[kind] as Record<string, { mutation?: true; storage?: "scoped" }>
    )[capability];
    if (requirement?.mutation) {
      if (data.mutation !== "explicit") {
        push(
          diagnostics,
          "CAPABILITY_MUTATION_SEMANTICS_REQUIRED",
          "/data/mutation",
          `${kind}:${capability} requires explicit mutation semantics.`,
        );
      }
      if (grants.mutation !== true) {
        push(
          diagnostics,
          "CAPABILITY_MUTATION_GRANT_REQUIRED",
          `/capabilities/${index}`,
          `${kind}:${capability} requires mutation authority.`,
        );
      }
    }
    if (requirement?.storage === "scoped") {
      if (data.cache !== "persistent") {
        push(
          diagnostics,
          "CAPABILITY_STORAGE_SEMANTICS_REQUIRED",
          "/data/cache",
          `${kind}:${capability} requires persistent cache semantics.`,
        );
      }
      if (grants.storage !== "scoped") {
        push(
          diagnostics,
          "CAPABILITY_STORAGE_GRANT_REQUIRED",
          `/capabilities/${index}`,
          `${kind}:${capability} requires scoped storage authority.`,
        );
      }
    }
  }
}

function normalizeEntrypoint(value: string, diagnostics: HonuaPluginDiagnostic[]): string | undefined {
  let decoded = value;
  try {
    for (let round = 0; round < 8; round += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (round === 7 && decodeURIComponent(decoded) !== decoded) throw new URIError("too many encodings");
    }
  } catch {
    push(
      diagnostics,
      "ENTRYPOINT_ENCODING_INVALID",
      "/package/entrypoint",
      "Entrypoint contains invalid or excessive percent encoding.",
    );
    return undefined;
  }
  const segments = decoded.split("/");
  const unsafe =
    !decoded.startsWith("./") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    segments[0] !== "." ||
    segments.length < 2 ||
    segments.slice(1).some((segment) => segment.length === 0 || segment === "." || segment === "..");
  if (unsafe) {
    push(
      diagnostics,
      "ENTRYPOINT_UNSAFE",
      "/package/entrypoint",
      "Entrypoint must decode to a package-relative path without traversal or absolute escape.",
    );
    return undefined;
  }
  return decoded;
}

function normalizeManifest(parts: {
  manifest: JsonObject;
  packageInfo: JsonObject;
  entrypoint: string;
  compatibility: JsonObject;
  environments: readonly string[];
  capabilities: readonly string[];
  peers: readonly JsonObject[];
  grants: NormalizedGrants;
  data: JsonObject;
  lifecycle: JsonObject;
  supportStatus: JsonObject | undefined;
}): HonuaPluginJsonValue {
  const normalized: Record<string, HonuaPluginJsonValue> = {
    manifestVersion: parts.manifest.manifestVersion as number,
    id: parts.manifest.id as string,
    version: parts.manifest.version as string,
    kind: parts.manifest.kind as string,
    package: { name: parts.packageInfo.name as string, entrypoint: parts.entrypoint },
    compatibility: {
      pluginApi: parts.compatibility.pluginApi as string,
      minimumSdk: parts.compatibility.minimumSdk as string,
      ...(typeof parts.compatibility.maximumSdkExclusive === "string"
        ? { maximumSdkExclusive: parts.compatibility.maximumSdkExclusive }
        : {}),
      environments: [...parts.environments].sort(asciiCompare),
    },
    capabilities: [...parts.capabilities].sort(asciiCompare),
    ...(parts.peers.length > 0 ? { peers: parts.peers } : {}),
    requestedGrants: compactGrants(parts.grants),
    data: parts.data,
    lifecycle: parts.lifecycle,
    support: parts.manifest.support as string,
    ...(parts.supportStatus ? { supportStatus: compactSupportStatus(parts.supportStatus) } : {}),
  };
  return deepFreeze(normalized);
}

function compactSupportStatus(status: JsonObject): HonuaPluginJsonValue {
  return {
    state: status.state as string,
    ...(typeof status.since === "string" ? { since: status.since } : {}),
    ...(typeof status.removedIn === "string" ? { removedIn: status.removedIn } : {}),
    ...(typeof status.replacement === "string" ? { replacement: status.replacement } : {}),
  };
}

function compactGrants(grants: NormalizedGrants): HonuaPluginJsonValue {
  return {
    ...(grants.networkOrigins.length > 0 ? { networkOrigins: grants.networkOrigins } : {}),
    ...(grants.credentialScopes.length > 0 ? { credentialScopes: grants.credentialScopes } : {}),
    ...(grants.storage !== undefined ? { storage: grants.storage } : {}),
    ...(grants.mutation !== undefined ? { mutation: grants.mutation } : {}),
  };
}

/** Validate an untrusted host snapshot without throwing or coercing values. */
export function validateHonuaPluginCertificationHost(input: string): HonuaPluginHostValidation {
  const inert = snapshotPlainJson(input, "/host");
  if (!inert.ok || inert.value === undefined) return { ok: false, diagnostics: inert.diagnostics };
  const diagnostics: HonuaPluginDiagnostic[] = [];
  const host = requiredObject(inert.value, "/host", diagnostics);
  allowedKeys(host, ["pluginApi", "sdkVersion", "environment", "peers", "grants"], "/host", diagnostics);
  if (host?.pluginApi !== HONUA_PLUGIN_API_VERSION)
    push(diagnostics, "HOST_PLUGIN_API_UNSUPPORTED", "/host/pluginApi", `Expected ${HONUA_PLUGIN_API_VERSION}.`);
  validateExactSemver(host?.sdkVersion, "/host/sdkVersion", diagnostics);
  if (typeof host?.environment !== "string" || !HONUA_PLUGIN_ENVIRONMENTS.includes(host.environment as never)) {
    push(diagnostics, "HOST_ENVIRONMENT_INVALID", "/host/environment", "Unknown host environment.");
  }
  const peers = requiredPeersObject(host?.peers, diagnostics);
  const grants = validateGrants(host?.grants, "/host/grants", diagnostics, false);
  const sorted = sortDiagnostics(diagnostics);
  if (!host || sorted.some((item) => item.severity === "error"))
    return { ok: false, snapshot: inert.value, diagnostics: sorted };
  const normalized = deepFreeze({
    pluginApi: host.pluginApi as string,
    sdkVersion: host.sdkVersion as string,
    environment: host.environment as string,
    peers,
    grants: compactGrants(grants as NormalizedGrants),
  });
  return {
    ok: true,
    host: normalized as unknown as HonuaPluginCertificationHost,
    snapshot: normalized,
    diagnostics: sorted,
  };
}

function requiredPeersObject(
  value: HonuaPluginJsonValue | undefined,
  diagnostics: HonuaPluginDiagnostic[],
): JsonObject {
  if (value === undefined) return {};
  const peers = requiredObject(value, "/host/peers", diagnostics);
  if (!peers) return {};
  for (const [name, version] of Object.entries(peers)) {
    if (!validPackageName(name))
      push(diagnostics, "PACKAGE_NAME_INVALID", `/host/peers/${escapePointer(name)}`, "Expected an npm package name.");
    validateExactSemver(version, `/host/peers/${escapePointer(name)}`, diagnostics);
  }
  return peers;
}

/**
 * Certify a manifest against one explicit host snapshot. The returned report
 * is deeply frozen and binds both complete canonical snapshots by SHA-256.
 */
export function certifyHonuaPluginManifest(input: string, hostInput: string): HonuaPluginCertificationReport {
  const manifestValidation = validateHonuaPluginManifest(input);
  const hostValidation = validateHonuaPluginCertificationHost(hostInput);
  const diagnostics = [...manifestValidation.diagnostics, ...hostValidation.diagnostics];
  const manifest = manifestValidation.manifest;
  const host = hostValidation.host;

  if (manifest && host) {
    const hostVersion = parseSemver(host.sdkVersion) as ParsedSemver;
    const minimum = parseSemver(manifest.compatibility.minimumSdk) as ParsedSemver;
    const maximum = manifest.compatibility.maximumSdkExclusive
      ? parseSemver(manifest.compatibility.maximumSdkExclusive)
      : undefined;
    if (compareSemver(hostVersion, minimum) < 0)
      push(diagnostics, "HOST_SDK_TOO_OLD", "/compatibility/minimumSdk", "Host SDK is older than the plugin minimum.");
    if (maximum && compareSemver(hostVersion, maximum) >= 0)
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
    certifyPeers(manifest, host, diagnostics);
    certifyGrants(manifest, host, diagnostics);
  }

  const sorted = sortDiagnostics(diagnostics);
  const errorCodes = new Set(sorted.filter((item) => item.severity === "error").map((item) => item.code));
  const manifestSnapshot = manifestValidation.snapshot ?? null;
  const hostSnapshot = hostValidation.snapshot ?? null;
  const unsignedReport = {
    reportVersion: HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION,
    plugin: manifest ? { id: manifest.id, version: manifest.version, kind: manifest.kind } : null,
    status: errorCodes.size === 0 ? ("certified" as const) : ("rejected" as const),
    manifest: { snapshot: manifestSnapshot, sha256: fingerprint(manifestSnapshot) },
    host: { snapshot: hostSnapshot, sha256: fingerprint(hostSnapshot) },
    checks: CHECKS.map((check) => {
      const diagnosticCodes = sorted
        .filter((item) => diagnosticCheck(item.code, item.path) === check)
        .map((item) => item.code);
      return {
        check,
        status: diagnosticCodes.some((code) => errorCodes.has(code)) ? ("failed" as const) : ("passed" as const),
        diagnosticCodes,
      };
    }),
    diagnostics: sorted,
  };
  const report = {
    ...unsignedReport,
    sha256: sha256(canonicalStringify(unsignedReport as unknown as Parameters<typeof canonicalStringify>[0])),
  };
  return deepFreeze(report as unknown as HonuaPluginJsonValue) as unknown as HonuaPluginCertificationReport;
}

/**
 * Re-check an archived certification report's integrity digests. The report is
 * read as inert JSON text; every stored SHA-256 (the top-level receipt plus the
 * manifest and host fingerprints) is recomputed from the report's own canonical
 * content and compared. Any mismatch — a tampered snapshot, a swapped digest, or
 * an edited diagnostic — yields a structured rejection. No plugin code runs.
 */
export function verifyHonuaPluginCertificationReport(input: string): HonuaPluginReportVerification {
  const inert = snapshotPlainJson(input, "/report");
  if (!inert.ok || inert.value === undefined) return { ok: false, status: null, diagnostics: inert.diagnostics };
  const diagnostics: HonuaPluginDiagnostic[] = [];
  const report = object(inert.value);
  if (!report) {
    push(diagnostics, "REPORT_TYPE", "/report", "Expected a certification report object.");
    return { ok: false, status: null, diagnostics };
  }

  validateCertificationReportShape(report, diagnostics);

  const status = report.status === "certified" || report.status === "rejected" ? report.status : null;
  const stated = typeof report.sha256 === "string" ? report.sha256 : undefined;
  if (stated === undefined) {
    push(diagnostics, "REPORT_SIGNATURE_MISSING", "/report/sha256", "Report is missing its integrity digest.");
  } else if (!isDigest(stated)) {
    push(diagnostics, "REPORT_SIGNATURE_INVALID", "/report/sha256", "Expected a SHA-256 integrity digest.");
  } else {
    const { sha256: _omit, ...unsigned } = report as Record<string, HonuaPluginJsonValue>;
    const recomputed = sha256(canonicalStringify(unsigned as unknown as Parameters<typeof canonicalStringify>[0]));
    if (recomputed !== stated) {
      push(
        diagnostics,
        "REPORT_SIGNATURE_MISMATCH",
        "/report/sha256",
        "Recomputed report digest does not match the stored value; the report was altered.",
      );
    }
  }

  verifyEmbeddedFingerprint(report.manifest, "/report/manifest", diagnostics);
  verifyEmbeddedFingerprint(report.host, "/report/host", diagnostics);

  const sorted = sortDiagnostics(diagnostics);
  return { ok: sorted.length === 0, status, diagnostics: sorted };
}

function verifyEmbeddedFingerprint(
  value: HonuaPluginJsonValue | undefined,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): void {
  const block = object(value);
  if (!block || !("snapshot" in block) || !("sha256" in block)) {
    push(diagnostics, "REPORT_BLOCK_INVALID", path, "Report block must carry a snapshot and its digest.");
    return;
  }
  const snapshot = block.snapshot === undefined ? null : block.snapshot;
  const stated = block.sha256 === null ? null : typeof block.sha256 === "string" ? block.sha256 : undefined;
  if (stated === undefined) {
    push(diagnostics, "REPORT_FINGERPRINT_INVALID", `${path}/sha256`, "Expected a SHA-256 digest or null.");
    return;
  }
  if (stated !== null && !isDigest(stated)) {
    push(diagnostics, "REPORT_FINGERPRINT_INVALID", `${path}/sha256`, "Expected a SHA-256 digest or null.");
    return;
  }
  const recomputed = fingerprint(snapshot);
  if (recomputed !== stated) {
    push(
      diagnostics,
      "REPORT_FINGERPRINT_MISMATCH",
      `${path}/sha256`,
      "Recomputed snapshot fingerprint does not match the stored value; the snapshot was altered.",
    );
  }
}

function validateCertificationReportShape(report: JsonObject, diagnostics: HonuaPluginDiagnostic[]): void {
  reportAllowedKeys(
    report,
    ["reportVersion", "sha256", "plugin", "status", "manifest", "host", "checks", "diagnostics"],
    "/report",
    diagnostics,
  );
  if (report.reportVersion !== HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION) {
    push(
      diagnostics,
      "REPORT_VERSION_UNSUPPORTED",
      "/report/reportVersion",
      `Expected ${HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION}.`,
    );
  }
  validateReportPlugin(report.plugin, diagnostics);
  validateReportStatus(report.status, diagnostics);
  validateReportBlock(report.manifest, "/report/manifest", diagnostics);
  validateReportBlock(report.host, "/report/host", diagnostics);

  if (!Array.isArray(report.checks)) {
    push(diagnostics, "REPORT_FIELD_INVALID", "/report/checks", "Expected an array of certification checks.");
  } else {
    for (const [index, value] of report.checks.entries()) {
      const check = object(value);
      const path = `/report/checks/${index}`;
      if (!check) {
        push(diagnostics, "REPORT_FIELD_INVALID", path, "Expected a certification check object.");
        continue;
      }
      reportAllowedKeys(check, ["check", "status", "diagnosticCodes"], path, diagnostics);
      if (!CHECKS.includes(check.check as HonuaPluginCertificationCheck))
        push(diagnostics, "REPORT_FIELD_INVALID", `${path}/check`, "Unknown certification check.");
      if (check.status !== "passed" && check.status !== "failed")
        push(diagnostics, "REPORT_FIELD_INVALID", `${path}/status`, "Expected passed or failed.");
      if (!isStringArray(check.diagnosticCodes))
        push(diagnostics, "REPORT_FIELD_INVALID", `${path}/diagnosticCodes`, "Expected an array of diagnostic codes.");
    }
  }

  if (!Array.isArray(report.diagnostics)) {
    push(diagnostics, "REPORT_FIELD_INVALID", "/report/diagnostics", "Expected an array of diagnostics.");
  } else {
    for (const [index, value] of report.diagnostics.entries()) {
      const diagnostic = object(value);
      const path = `/report/diagnostics/${index}`;
      if (!diagnostic) {
        push(diagnostics, "REPORT_FIELD_INVALID", path, "Expected a diagnostic object.");
        continue;
      }
      reportAllowedKeys(diagnostic, ["code", "severity", "path", "message"], path, diagnostics);
      for (const field of ["code", "path", "message"] as const) {
        if (typeof diagnostic[field] !== "string" || diagnostic[field].length === 0)
          push(diagnostics, "REPORT_FIELD_INVALID", `${path}/${field}`, "Expected a non-empty string.");
      }
      if (diagnostic.severity !== "error" && diagnostic.severity !== "warning")
        push(diagnostics, "REPORT_FIELD_INVALID", `${path}/severity`, "Expected error or warning.");
    }
  }
}

function validateReportPlugin(value: HonuaPluginJsonValue | undefined, diagnostics: HonuaPluginDiagnostic[]): void {
  if (value === null) return;
  const plugin = object(value);
  if (!plugin) {
    push(diagnostics, "REPORT_FIELD_INVALID", "/report/plugin", "Expected a plugin identity object or null.");
    return;
  }
  reportAllowedKeys(plugin, ["id", "version", "kind"], "/report/plugin", diagnostics);
  for (const field of ["id", "version", "kind"] as const) {
    if (typeof plugin[field] !== "string" || plugin[field].length === 0)
      push(diagnostics, "REPORT_FIELD_INVALID", `/report/plugin/${field}`, "Expected a non-empty string.");
  }
}

function validateReportStatus(value: HonuaPluginJsonValue | undefined, diagnostics: HonuaPluginDiagnostic[]): void {
  if (value !== "certified" && value !== "rejected")
    push(diagnostics, "REPORT_FIELD_INVALID", "/report/status", "Expected certified or rejected.");
}

function validateReportBlock(
  value: HonuaPluginJsonValue | undefined,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): void {
  const block = object(value);
  if (!block) {
    push(diagnostics, "REPORT_BLOCK_INVALID", path, "Report block must carry a snapshot and its digest.");
    return;
  }
  reportAllowedKeys(block, ["snapshot", "sha256"], path, diagnostics);
  if (!("snapshot" in block)) push(diagnostics, "REPORT_BLOCK_INVALID", `${path}/snapshot`, "Snapshot is required.");
  if (!("sha256" in block)) push(diagnostics, "REPORT_BLOCK_INVALID", `${path}/sha256`, "Digest is required.");
}

function reportAllowedKeys(
  value: JsonObject,
  keys: readonly string[],
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) push(diagnostics, "REPORT_UNKNOWN_FIELD", `${path}/${escapePointer(key)}`, "Unknown field.");
  }
}

function isStringArray(value: HonuaPluginJsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function certifyPeers(
  manifest: HonuaPluginManifest,
  host: HonuaPluginCertificationHost,
  diagnostics: HonuaPluginDiagnostic[],
): void {
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
    if (compareSemver(parseSemver(installed) as ParsedSemver, parseSemver(peer.minimumVersion) as ParsedSemver) < 0) {
      push(diagnostics, "HOST_PEER_TOO_OLD", `/peers/${index}/minimumVersion`, `Installed ${peer.name} is too old.`);
    }
  }
}

function certifyGrants(
  manifest: HonuaPluginManifest,
  host: HonuaPluginCertificationHost,
  diagnostics: HonuaPluginDiagnostic[],
): void {
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
  if (manifest.requestedGrants.storage === "scoped" && host.grants?.storage !== "scoped") {
    push(diagnostics, "STORAGE_GRANT_MISSING", "/requestedGrants/storage", "Application did not grant scoped storage.");
  }
  if (manifest.requestedGrants.mutation === true && host.grants?.mutation !== true) {
    push(
      diagnostics,
      "MUTATION_GRANT_MISSING",
      "/requestedGrants/mutation",
      "Application did not grant mutation authority.",
    );
  }
}

function fingerprint(value: HonuaPluginJsonValue | null): `sha256:${string}` | null {
  return value === null ? null : sha256(canonicalStringify(value as Parameters<typeof canonicalStringify>[0]));
}

function validateEnum(
  value: HonuaPluginJsonValue | undefined,
  allowed: readonly string[],
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): void {
  if (typeof value !== "string" || !allowed.includes(value))
    push(diagnostics, "MANIFEST_ENUM", path, `Expected one of: ${allowed.join(", ")}.`);
}

function diagnosticCheck(code: string, path: string): HonuaPluginCertificationCheck {
  // Route by path first: generic type/enum/semver codes emitted for a
  // supportStatus field must fail the support check, not the manifest check.
  if (code.startsWith("SUPPORT") || path === "/supportStatus" || path.startsWith("/supportStatus/")) return "support";
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

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapePointer(value: string): string {
  return value.split("~").join("~0").split("/").join("~1");
}

function validPluginId(value: string): boolean {
  if (validPackageName(value) && value.startsWith("@")) return true;
  const segments = value.split(".");
  return segments.length >= 2 && segments.every(validLowercaseNameSegment);
}

function validPackageName(value: string): boolean {
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    return (
      slash > 1 &&
      value.indexOf("/", slash + 1) === -1 &&
      validLowercaseNameSegment(value.slice(1, slash)) &&
      validLowercaseNameSegment(value.slice(slash + 1))
    );
  }
  return !value.includes("/") && validLowercaseNameSegment(value);
}

function validLowercaseNameSegment(value: string): boolean {
  if (value.length === 0 || !asciiLowercaseAlphanumeric(value.charCodeAt(0))) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!asciiLowercaseAlphanumeric(code) && code !== 45 && code !== 46 && code !== 95) return false;
  }
  return true;
}

function validCredentialScope(value: string): boolean {
  if (value.length === 0 || value.length > 128 || !asciiAlphanumeric(value.charCodeAt(0))) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!asciiAlphanumeric(code) && code !== 45 && code !== 46 && code !== 47 && code !== 58 && code !== 95) {
      return false;
    }
  }
  return true;
}

function asciiLowercaseAlphanumeric(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function asciiAlphanumeric(code: number): boolean {
  return asciiLowercaseAlphanumeric(code) || (code >= 65 && code <= 90);
}
