/** Version of the JSON-compatible plugin manifest contract. */
export const HONUA_PLUGIN_MANIFEST_VERSION = 1 as const;

/** Version of the host/plugin API described by this package. */
export const HONUA_PLUGIN_API_VERSION = "1.0" as const;

export const HONUA_PLUGIN_KINDS = [
  "protocol",
  "source-format",
  "renderer",
  "auth",
  "geocoder-routing",
  "analysis",
  "style",
  "cache",
  "realtime",
] as const;

export type HonuaPluginKind = (typeof HONUA_PLUGIN_KINDS)[number];

export const HONUA_PLUGIN_ENVIRONMENTS = ["browser", "node", "worker"] as const;
export type HonuaPluginEnvironment = (typeof HONUA_PLUGIN_ENVIRONMENTS)[number];

/** Closed capability vocabulary for each extension kind. */
export const HONUA_PLUGIN_CAPABILITIES = {
  protocol: ["query", "edit", "render", "tiles", "stream"],
  "source-format": ["read", "write", "stream"],
  renderer: ["2d", "3d", "picking", "export"],
  auth: ["authorize", "refresh", "revoke"],
  "geocoder-routing": ["geocode", "reverse-geocode", "route"],
  analysis: ["execute", "stream", "cancel"],
  style: ["translate", "validate"],
  cache: ["read", "write", "invalidate"],
  realtime: ["subscribe", "resume", "acknowledge"],
} as const satisfies Record<HonuaPluginKind, readonly string[]>;

export type HonuaPluginCapability<K extends HonuaPluginKind = HonuaPluginKind> =
  (typeof HONUA_PLUGIN_CAPABILITIES)[K][number];

export interface HonuaPluginCompatibility {
  /** Must equal the host's plugin API version. */
  readonly pluginApi: typeof HONUA_PLUGIN_API_VERSION;
  /** Lowest supported SDK version (inclusive), expressed as an exact SemVer. */
  readonly minimumSdk: string;
  /** Optional first unsupported SDK version (exclusive), expressed as an exact SemVer. */
  readonly maximumSdkExclusive?: string;
  readonly environments: readonly HonuaPluginEnvironment[];
}

export interface HonuaPluginPeerRequirement {
  readonly name: string;
  /** Lowest supported peer version (inclusive), expressed as an exact SemVer. */
  readonly minimumVersion: string;
  readonly optional?: boolean;
}

/** Authorities requested from the application. Values are identifiers, never secrets. */
export interface HonuaPluginRequestedGrants {
  readonly networkOrigins?: readonly string[];
  readonly credentialScopes?: readonly string[];
  readonly storage?: "none" | "scoped";
  readonly mutation?: boolean;
}

export interface HonuaPluginDataSemantics {
  readonly cache: "none" | "memory" | "persistent";
  readonly freshness: "snapshot" | "ttl" | "realtime";
  readonly authentication: "none" | "application-grant";
  readonly provenance: "preserved" | "derived";
  readonly mutation: "none" | "explicit";
  readonly realtime: "none" | "polling" | "push";
}

export interface HonuaPluginLifecycle {
  /** Initialization is always initiated by the owning application. */
  readonly initialization: "explicit";
  /** Whether the host must call the plugin's future disposal hook. */
  readonly disposal: "none" | "required";
}

/** Serializable, side-effect-free declaration consumed before any plugin code. */
export interface HonuaPluginManifest<K extends HonuaPluginKind = HonuaPluginKind> {
  readonly manifestVersion: typeof HONUA_PLUGIN_MANIFEST_VERSION;
  readonly id: string;
  readonly version: string;
  readonly kind: K;
  readonly package: {
    readonly name: string;
    /** Package-relative ESM entrypoint. Validation never imports it. */
    readonly entrypoint: string;
  };
  readonly compatibility: HonuaPluginCompatibility;
  readonly capabilities: readonly HonuaPluginCapability<K>[];
  readonly peers?: readonly HonuaPluginPeerRequirement[];
  readonly requestedGrants: HonuaPluginRequestedGrants;
  readonly data: HonuaPluginDataSemantics;
  readonly lifecycle: HonuaPluginLifecycle;
  readonly support: "community" | "partner" | "honua";
}

export interface HonuaPluginGrantedAuthorities {
  readonly networkOrigins?: readonly string[];
  readonly credentialScopes?: readonly string[];
  readonly storage?: "none" | "scoped";
  readonly mutation?: boolean;
}

export interface HonuaPluginCertificationHost {
  readonly pluginApi: typeof HONUA_PLUGIN_API_VERSION;
  readonly sdkVersion: string;
  readonly environment: HonuaPluginEnvironment;
  /** Installed peer versions keyed by package name. */
  readonly peers?: Readonly<Record<string, string>>;
  /** Authorities the application deliberately makes available to this plugin. */
  readonly grants?: HonuaPluginGrantedAuthorities;
}

export type HonuaPluginDiagnosticSeverity = "error" | "warning";

export interface HonuaPluginDiagnostic {
  readonly code: string;
  readonly severity: HonuaPluginDiagnosticSeverity;
  /** JSON Pointer into the manifest, or `/` for the document itself. */
  readonly path: string;
  readonly message: string;
}

export type HonuaPluginCertificationCheck =
  | "manifest"
  | "compatibility"
  | "environment"
  | "capabilities"
  | "peers"
  | "security-boundary";

export interface HonuaPluginCheckResult {
  readonly check: HonuaPluginCertificationCheck;
  readonly status: "passed" | "failed";
  readonly diagnosticCodes: readonly string[];
}

/** Deterministic JSON-compatible report; it contains no timestamps or host paths. */
export interface HonuaPluginCertificationReport {
  readonly reportVersion: 1;
  readonly manifestVersion: number | null;
  readonly plugin: { readonly id: string; readonly version: string; readonly kind: string } | null;
  readonly status: "certified" | "rejected";
  readonly host: {
    readonly pluginApi: string;
    readonly sdkVersion: string;
    readonly environment: string;
  };
  readonly checks: readonly HonuaPluginCheckResult[];
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}

export interface HonuaPluginManifestValidation {
  readonly ok: boolean;
  readonly manifest?: HonuaPluginManifest;
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}
