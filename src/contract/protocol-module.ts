/**
 * Minimal protocol-module composition (issue #538).
 *
 * `RendererAdapter` (`src/kernel/renderer.ts`) is the accepted, plain,
 * injectable seam every mounted renderer satisfies — first-party
 * (`maplibreRenderer`) and an external, non-Web-Mercator renderer plugin
 * (issue #566) alike — without the kernel importing the plugin SDK or
 * maintaining a privileged construction path. `ProtocolModule` is the
 * equivalent minimal
 * seam for a `Source.protocol(...)` escape-hatch adapter: discovery, the
 * capability set it advertises for a descriptor, diagnostics, and
 * disposal. Query-capable modules implement the atomic
 * {@link QueryCapableProtocolModule} extension, whose deterministic `compile`
 * and explicitly-authorized `execute` hooks are always present together.
 * Tiles-only modules such as PMTiles implement only this base interface.
 *
 * This module has no dependency on `src/plugin` or any global registry: a
 * `ProtocolModule` is a plain value object. SDK-internal `Source`
 * construction (for example `pmtilesSource()`) and a module packaged as a
 * `HonuaPluginFactory<"protocol">` for `HonuaPluginRegistry`
 * (`src/plugin/pmtiles-protocol-plugin.ts`) both consume exactly this shape,
 * which is what proves the built-in adapter carries no special registry
 * privilege.
 *
 * @module
 */
import type { Capabilities, Protocol, Result, SourceDescriptor } from "./types.js";

/** Runtime environments a protocol module can execute in. Mirrors `RendererEnvironment`. */
export type ProtocolModuleEnvironment = "browser" | "node" | "worker";

/** Stable, protocol-neutral diagnostic exposed by one discovered module handle. */
export interface ProtocolModuleDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
}

export interface ProtocolModuleDiscoverOptions {
  readonly signal?: AbortSignal;
}

/** Canonical query-family operations a protocol module may compile and execute. */
export type ProtocolModuleQueryOperation = "query" | "queryAll" | "queryAggregate";

/**
 * Type binding for one module's query seam.
 *
 * The compiler source identity is deliberately separate from
 * {@link SourceDescriptor}: deterministic compilers receive a
 * credential-free, serializable identity rather than a runtime descriptor
 * or client. The execution query may carry runtime-only values such as an
 * `AbortSignal`; those values never enter the compiled artifact.
 */
export interface ProtocolModuleQueryBinding {
  readonly source: unknown;
  readonly compileQuery: unknown;
  readonly compiled: unknown;
  readonly executeQuery: unknown;
}

/** Pure input to a protocol module's deterministic compiler. */
export interface ProtocolModuleQueryCompileInput<TSource = unknown, TQuery = unknown> {
  readonly source: TSource;
  readonly query: TQuery;
  readonly operation: ProtocolModuleQueryOperation;
}

/**
 * Runtime input to a protocol module executor.
 *
 * `compiled` is the inspectable, credential-free artifact. Runtime authority
 * stays on the discovered handle and on dependencies explicitly injected into
 * the module factory. `signal` is execution state and is never part of the
 * artifact's deterministic identity.
 */
export interface ProtocolModuleQueryExecuteInput<TCompiled = unknown, TQuery = unknown> {
  readonly compiled: TCompiled;
  readonly query: TQuery;
  readonly operation: ProtocolModuleQueryOperation;
  readonly signal?: AbortSignal;
}

/**
 * One discovered, disposable protocol-module handle bound to a source
 * descriptor. `adapter` is the same typed escape-hatch value historically
 * returned by `Source.protocol(name)` (for example a `HonuaPmtilesArchive`),
 * so migrating a built-in onto this seam never changes what callers observe
 * through the existing escape hatch.
 *
 * `TProtocol` mirrors the descriptor kind a `ProtocolModule<TKind>` accepts
 * (built-in `Protocol` by default, or `TKind | Protocol` when parameterized
 * by `discover()` below) so a handle for a custom-kind descriptor carries
 * that kind through rather than widening to `string`.
 */
export interface ProtocolModuleHandle<TAdapter = unknown, TProtocol extends string = Protocol> {
  readonly descriptor: SourceDescriptor<TProtocol>;
  readonly capabilities: Capabilities;
  readonly adapter: TAdapter;
  readonly diagnostics: readonly ProtocolModuleDiagnostic[];
  dispose(): void | Promise<void>;
}

/**
 * Minimal executable protocol seam. Heavy peers are injected as values
 * (`peer`) and are never imported by SDK core; discovery stays lazy so a
 * module that is registered but never discovered pays no I/O or peer-import
 * cost. `discover` may return synchronously when construction needs no I/O
 * (as PMTiles does — the archive itself is opened lazily on first
 * `describe()`), or asynchronously for a module whose discovery is
 * inherently a network round trip.
 *
 * `capabilities()`/`discover()` accept `SourceDescriptor<TKind | Protocol>`
 * — the built-in `Protocol` union plus this module's own `TKind` — so a
 * third-party module with a custom protocol id (e.g. the cloud-tiles fixture's
 * `"cloud-tiles"`, `test/fixtures/plugins/cloud-tiles/protocol-module.ts`)
 * can pass a descriptor typed to its own kind without an `as` cast, matching
 * how `pmtilesProtocolModule()` (`src/contract/pmtiles.ts`) already accepts
 * `SourceDescriptor<"pmtiles" | Protocol>`, i.e. `SourceDescriptor` (issue
 * #671).
 */
export interface ProtocolModule<TKind extends string = string, TAdapter = unknown> {
  readonly kind: TKind;
  readonly environments: readonly ProtocolModuleEnvironment[];
  readonly peer?: unknown;
  /** Pure and synchronous: never performs I/O. */
  capabilities(descriptor: SourceDescriptor<TKind | Protocol>): Capabilities;
  discover(
    descriptor: SourceDescriptor<TKind | Protocol>,
    options?: ProtocolModuleDiscoverOptions,
  ): ProtocolModuleHandle<TAdapter, TKind | Protocol> | Promise<ProtocolModuleHandle<TAdapter, TKind | Protocol>>;
}

/**
 * Atomic query-capable extension of {@link ProtocolModule}.
 *
 * A module either implements this interface and therefore provides both
 * hooks, or implements the discovery-only base interface and provides
 * neither. Keeping the pair in a separate required interface prevents
 * partially executable modules from satisfying the public contract.
 */
export interface QueryCapableProtocolModule<
  TKind extends string = string,
  TAdapter = unknown,
  TQueryBinding extends ProtocolModuleQueryBinding = ProtocolModuleQueryBinding,
> extends ProtocolModule<TKind, TAdapter> {
  /** Deterministic, synchronous, and I/O-free query compiler. */
  compile(
    input: ProtocolModuleQueryCompileInput<TQueryBinding["source"], TQueryBinding["compileQuery"]>,
  ): TQueryBinding["compiled"];
  /**
   * Explicitly-authorized executor paired with {@link compile}.
   * Implementations execute only against the supplied discovered handle and
   * must not consult or mutate an ambient registry.
   */
  execute<TRecord = Record<string, unknown>>(
    handle: ProtocolModuleHandle<TAdapter, TKind | Protocol>,
    input: ProtocolModuleQueryExecuteInput<TQueryBinding["compiled"], TQueryBinding["executeQuery"]>,
  ): Promise<Result<TRecord>>;
}
