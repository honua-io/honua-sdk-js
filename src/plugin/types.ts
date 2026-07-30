/** Version of the JSON-compatible plugin manifest contract. */
export const HONUA_PLUGIN_MANIFEST_VERSION = 1 as const;

/** Version of the host/plugin API described by this package. */
export const HONUA_PLUGIN_API_VERSION = "1.0" as const;

/** Version of the archived manifest-certification report schema. */
export const HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION = 1 as const;

/** Version of the host-mediated certification signing envelope contract. */
export const HONUA_PLUGIN_CERTIFICATION_SIGNING_ENVELOPE_VERSION = 1 as const;

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

/** Machine-readable lifecycle stage of the plugin under its author's support program. */
export const HONUA_PLUGIN_SUPPORT_STATES = Object.freeze(["supported", "experimental", "deprecated"] as const);
export type HonuaPluginSupportState = (typeof HONUA_PLUGIN_SUPPORT_STATES)[number];

/**
 * Optional support-status attestation. `support` records who backs the plugin
 * (its tier); `supportStatus` records the machine-readable lifecycle stage plus
 * metadata that applications and agents can act on without loading plugin code.
 * A `deprecated` plugin must name a `replacement` id or a `removedIn` version so
 * consumers can plan a migration; certification fails closed otherwise.
 */
export interface HonuaPluginSupportStatus {
  readonly state: HonuaPluginSupportState;
  /** Exact SemVer at which this state took effect. */
  readonly since?: string;
  /** Exact SemVer at or after which a deprecated plugin stops being published. */
  readonly removedIn?: string;
  /** Plugin id a deprecated plugin directs consumers to instead. */
  readonly replacement?: string;
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
  /** Optional machine-readable support-status attestation. */
  readonly supportStatus?: HonuaPluginSupportStatus;
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
  | "security-boundary"
  | "support";

export interface HonuaPluginCheckResult {
  readonly check: HonuaPluginCertificationCheck;
  readonly status: "passed" | "failed";
  readonly diagnosticCodes: readonly string[];
}

/** Deterministic JSON-compatible report; it contains no timestamps or host paths. */
export interface HonuaPluginCertificationReport {
  readonly reportVersion: typeof HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION;
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

/** Result of re-checking an archived certification report's integrity digests. */
export interface HonuaPluginReportVerification {
  /** True only when every recomputed digest matched the value stored in the report. */
  readonly ok: boolean;
  /** The report status when the report parsed, otherwise `null`. */
  readonly status: "certified" | "rejected" | null;
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}

/**
 * A certification report plus an application-selected external signature.
 * The SDK deliberately carries no key material or issuer policy; `keyId` is
 * only an opaque selector for the host's verifier.
 */
export interface HonuaPluginCertificationSigningEnvelope {
  readonly envelopeVersion: typeof HONUA_PLUGIN_CERTIFICATION_SIGNING_ENVELOPE_VERSION;
  readonly algorithm: "external";
  readonly keyId: string;
  readonly report: HonuaPluginCertificationReport;
  readonly signature: string;
}

/** Host-owned verification seam. Key lookup and cryptographic policy stay out of the SDK. */
export interface HonuaPluginCertificationSignatureVerifier {
  readonly verify: (
    canonicalPayload: string,
    signature: string,
    keyId: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}

export interface HonuaPluginCertificationSigningEnvelopeVerification {
  readonly ok: boolean;
  readonly status: "certified" | "rejected" | null;
  readonly keyId: string | null;
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}

export type HonuaPluginConformanceScenario = "retries" | "performance" | "bundle-metadata";

/** One deterministic measurement compared against a declared conformance bound. */
export interface HonuaPluginConformanceObservation {
  readonly metric: string;
  readonly observed: number;
  readonly bound: number;
  readonly comparison: "<=" | ">=" | "==";
  readonly satisfied: boolean;
}

export interface HonuaPluginConformanceScenarioResult {
  readonly scenario: HonuaPluginConformanceScenario;
  readonly status: "passed" | "failed";
  readonly observations: readonly HonuaPluginConformanceObservation[];
}

/**
 * Deterministic behavioral-conformance report. Like the certification report it
 * carries no timestamps or host paths, binds the certification digest it was run
 * against, and is sealed by a top-level SHA-256 so it can be archived as a
 * golden report and re-verified.
 */
export interface HonuaPluginConformanceReport {
  readonly reportVersion: 1;
  readonly sha256: `sha256:${string}`;
  readonly plugin: { readonly id: string; readonly version: string; readonly kind: string } | null;
  readonly status: "passed" | "failed";
  /** The certification the behavioral run depends on, bound by its digest. */
  readonly certification: {
    readonly status: "certified" | "rejected";
    readonly sha256: `sha256:${string}`;
  };
  readonly scenarios: readonly HonuaPluginConformanceScenarioResult[];
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

/** Exact dependency identity used for deterministic application-local ordering. */
export interface HonuaPluginDependency {
  readonly id: string;
  readonly version?: string;
  readonly kind?: HonuaPluginKind;
}

/** Host-provided network service. The registry restricts calls to declared origins. */
export interface HonuaPluginNetworkService {
  readonly request: (url: string, init?: unknown) => Promise<unknown>;
}

/** Host-provided credential service. Scope values are identifiers, never credentials. */
export interface HonuaPluginCredentialService {
  readonly get: (scope: string) => Promise<unknown>;
}

export interface HonuaPluginStorageService {
  readonly get: (key: string) => Promise<unknown>;
  readonly set: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

export interface HonuaPluginMutationService {
  readonly execute: (operation: unknown) => Promise<unknown>;
}

export interface HonuaPluginCacheService {
  readonly get: (key: string) => Promise<unknown>;
  readonly set?: (key: string, value: unknown) => Promise<void>;
}

export interface HonuaPluginProvenanceService {
  readonly record: (value: unknown) => void | Promise<void>;
}

export interface HonuaPluginRealtimeService {
  readonly subscribe: (request: unknown, signal: AbortSignal) => Promise<unknown>;
}

/** Services owned by one application. No service is discovered from global state. */
export interface HonuaPluginHostServices {
  readonly network?: HonuaPluginNetworkService;
  readonly credentials?: HonuaPluginCredentialService;
  readonly storage?: HonuaPluginStorageService;
  readonly mutation?: HonuaPluginMutationService;
  readonly cache?: HonuaPluginCacheService;
  readonly provenance?: HonuaPluginProvenanceService;
  readonly realtime?: HonuaPluginRealtimeService;
}

/** Grant- and data-semantics-scoped services visible to a single plugin. */
export type HonuaPluginScopedServices = Readonly<Partial<HonuaPluginHostServices>>;

export interface HonuaPluginExtension<K extends HonuaPluginKind> {
  readonly id: string;
  readonly kind: K;
}

/** Discriminated extension contract for every manifest kind. */
export interface HonuaPluginExtensionKindMap {
  readonly protocol: HonuaPluginExtension<"protocol">;
  readonly "source-format": HonuaPluginExtension<"source-format">;
  readonly renderer: HonuaPluginExtension<"renderer">;
  readonly auth: HonuaPluginExtension<"auth">;
  readonly "geocoder-routing": HonuaPluginExtension<"geocoder-routing">;
  readonly analysis: HonuaPluginExtension<"analysis">;
  readonly style: HonuaPluginExtension<"style">;
  readonly cache: HonuaPluginExtension<"cache">;
  readonly realtime: HonuaPluginExtension<"realtime">;
}

export interface HonuaPluginLifecycleContext<K extends HonuaPluginKind = HonuaPluginKind> {
  readonly manifest: HonuaPluginManifest<K>;
  readonly environment: HonuaPluginEnvironment;
  readonly services: HonuaPluginScopedServices;
  readonly signal: AbortSignal;
  /** Resolve an already initialized dependency from this application only. */
  readonly resolve: <
    D extends HonuaPluginKind,
    E extends HonuaPluginExtensionKindMap[D] = HonuaPluginExtensionKindMap[D],
  >(
    kind: D,
    id: string,
  ) => E | undefined;
}

/** Hooks are optional after initialize so inert plugins carry no lifecycle work. */
export interface HonuaPluginInstance<
  K extends HonuaPluginKind = HonuaPluginKind,
  E extends HonuaPluginExtensionKindMap[K] = HonuaPluginExtensionKindMap[K],
> {
  readonly extension: E;
  readonly start?: (context: HonuaPluginLifecycleContext<K>) => void | Promise<void>;
  readonly stop?: (context: HonuaPluginLifecycleContext<K>) => void | Promise<void>;
  readonly dispose?: (context: HonuaPluginLifecycleContext<K>) => void | Promise<void>;
}

export interface HonuaPluginFactory<
  K extends HonuaPluginKind = HonuaPluginKind,
  E extends HonuaPluginExtensionKindMap[K] = HonuaPluginExtensionKindMap[K],
> {
  /** Inert manifest bytes. The registry certifies these again immediately before initialize. */
  readonly manifest: string;
  readonly dependencies?: readonly HonuaPluginDependency[];
  readonly initialize: (
    context: HonuaPluginLifecycleContext<K>,
  ) => HonuaPluginInstance<K, E> | Promise<HonuaPluginInstance<K, E>>;
}

export type HonuaPluginLifecyclePhase = "certify" | "initialize" | "start" | "stop" | "dispose" | "registry";
export type HonuaPluginLifecycleStatus = "started" | "succeeded" | "failed" | "cancelled" | "rolled-back";

/** Stable, deeply immutable machine event. It intentionally contains no thrown error text. */
export interface HonuaPluginLifecycleDiagnostic {
  readonly sequence: number;
  readonly code: string;
  readonly phase: HonuaPluginLifecyclePhase;
  readonly status: HonuaPluginLifecycleStatus;
  readonly plugin: {
    readonly id: string;
    readonly version: string;
    readonly kind: HonuaPluginKind;
  } | null;
}

export interface HonuaPluginRegistryOptions {
  /** JSON text accepted by the certification trust boundary. */
  readonly host: string;
  readonly services?: HonuaPluginHostServices;
}
