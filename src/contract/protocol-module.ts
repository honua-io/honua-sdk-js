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
 * disposal. `compile`/`execute` are intentionally absent from this first
 * bounded slice — no first-party module has migrated its query-compiler
 * pipeline onto the seam yet (see `docs/plugin-manifest-certification.md`
 * for the tracked follow-up).
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
import type { Capabilities, Protocol, SourceDescriptor } from "./types.js";

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
