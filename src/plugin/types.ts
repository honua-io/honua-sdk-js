/** Version of the JSON-compatible plugin manifest contract. */
export const HONUA_PLUGIN_MANIFEST_VERSION = 1 as const;

/** Version of the host/plugin API described by this package. */
export const HONUA_PLUGIN_API_VERSION = "1.0" as const;

export const HONUA_PLUGIN_KINDS = Object.freeze([
  "protocol",
  "source-format",
  "renderer",
  "auth",
  "geocoder-routing",
  "analysis",
  "style",
  "cache",
  "realtime",
] as const);

export type HonuaPluginKind = (typeof HONUA_PLUGIN_KINDS)[number];

export const HONUA_PLUGIN_ENVIRONMENTS = Object.freeze(["browser", "node", "worker"] as const);
export type HonuaPluginEnvironment = (typeof HONUA_PLUGIN_ENVIRONMENTS)[number];

/** Closed capability vocabulary for each extension kind. */
export const HONUA_PLUGIN_CAPABILITIES = Object.freeze({
  protocol: Object.freeze(["query", "edit", "render", "tiles", "stream"] as const),
  "source-format": Object.freeze(["read", "write", "stream"] as const),
  renderer: Object.freeze(["2d", "3d", "picking", "export"] as const),
  auth: Object.freeze(["authorize", "refresh", "revoke"] as const),
  "geocoder-routing": Object.freeze(["geocode", "reverse-geocode", "route"] as const),
  analysis: Object.freeze(["execute", "stream", "cancel"] as const),
  style: Object.freeze(["translate", "validate"] as const),
  cache: Object.freeze(["read", "write", "invalidate"] as const),
  realtime: Object.freeze(["subscribe", "resume", "acknowledge"] as const),
} as const satisfies Record<HonuaPluginKind, readonly string[]>);

export type HonuaPluginCapability<K extends HonuaPluginKind = HonuaPluginKind> =
  (typeof HONUA_PLUGIN_CAPABILITIES)[K][number];

export interface HonuaPluginCapabilityRequiredGrant {
  readonly mutation?: true;
  readonly storage?: "scoped";
}

/**
 * Authority requirements derived from capability semantics. Empty entries are
 * deliberately read-only. Hosts and inventory tools can inspect this table
 * without loading plugin code.
 */
const NO_REQUIRED_GRANTS = Object.freeze({});
const MUTATION_REQUIRED = Object.freeze({ mutation: true } as const);
const SCOPED_STORAGE_REQUIRED = Object.freeze({ storage: "scoped" } as const);

export const HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS = Object.freeze({
  protocol: Object.freeze({
    query: NO_REQUIRED_GRANTS,
    edit: MUTATION_REQUIRED,
    render: NO_REQUIRED_GRANTS,
    tiles: NO_REQUIRED_GRANTS,
    stream: NO_REQUIRED_GRANTS,
  }),
  "source-format": Object.freeze({
    read: NO_REQUIRED_GRANTS,
    write: MUTATION_REQUIRED,
    stream: NO_REQUIRED_GRANTS,
  }),
  renderer: Object.freeze({
    "2d": NO_REQUIRED_GRANTS,
    "3d": NO_REQUIRED_GRANTS,
    picking: NO_REQUIRED_GRANTS,
    export: NO_REQUIRED_GRANTS,
  }),
  auth: Object.freeze({
    authorize: NO_REQUIRED_GRANTS,
    refresh: NO_REQUIRED_GRANTS,
    revoke: NO_REQUIRED_GRANTS,
  }),
  "geocoder-routing": Object.freeze({
    geocode: NO_REQUIRED_GRANTS,
    "reverse-geocode": NO_REQUIRED_GRANTS,
    route: NO_REQUIRED_GRANTS,
  }),
  analysis: Object.freeze({
    execute: NO_REQUIRED_GRANTS,
    stream: NO_REQUIRED_GRANTS,
    cancel: NO_REQUIRED_GRANTS,
  }),
  style: Object.freeze({ translate: NO_REQUIRED_GRANTS, validate: NO_REQUIRED_GRANTS }),
  cache: Object.freeze({
    read: NO_REQUIRED_GRANTS,
    write: SCOPED_STORAGE_REQUIRED,
    invalidate: SCOPED_STORAGE_REQUIRED,
  }),
  realtime: Object.freeze({
    subscribe: NO_REQUIRED_GRANTS,
    resume: NO_REQUIRED_GRANTS,
    acknowledge: NO_REQUIRED_GRANTS,
  }),
} as const satisfies {
  readonly [K in HonuaPluginKind]: {
    readonly [C in HonuaPluginCapability<K>]: HonuaPluginCapabilityRequiredGrant;
  };
});

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

export type HonuaPluginJsonPrimitive = null | boolean | number | string;
export type HonuaPluginJsonValue =
  | HonuaPluginJsonPrimitive
  | readonly HonuaPluginJsonValue[]
  | { readonly [key: string]: HonuaPluginJsonValue };

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
  /** Integrity digest over every other report field, including both snapshots and hashes. */
  readonly sha256: `sha256:${string}`;
  readonly plugin: { readonly id: string; readonly version: string; readonly kind: string } | null;
  readonly status: "certified" | "rejected";
  readonly manifest: {
    readonly snapshot: HonuaPluginJsonValue | null;
    readonly sha256: `sha256:${string}` | null;
  };
  readonly host: {
    readonly snapshot: HonuaPluginJsonValue | null;
    readonly sha256: `sha256:${string}` | null;
  };
  readonly checks: readonly HonuaPluginCheckResult[];
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}

export interface HonuaPluginManifestValidation {
  readonly ok: boolean;
  readonly manifest?: HonuaPluginManifest;
  readonly snapshot?: HonuaPluginJsonValue;
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}

export interface HonuaPluginHostValidation {
  readonly ok: boolean;
  readonly host?: HonuaPluginCertificationHost;
  readonly snapshot?: HonuaPluginJsonValue;
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}
