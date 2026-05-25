/**
 * Client types for the Studio capability manifest — the server-advertised
 * set of package families and feature capabilities a Console/MCP/QGIS client
 * may rely on. Lets a client gate UI and tool exposure on what the connected
 * server actually supports rather than hard-coding assumptions.
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @module
 */

/**
 * One constraint qualifying a capability (e.g. a max size or allowed value
 * set). Open-ended until the server constraint vocabulary is finalized.
 *
 * @experimental
 */
export interface StudioCapabilityConstraint {
  readonly kind: string;
  readonly value?: unknown;
  readonly [extra: string]: unknown;
}

/**
 * One advertised capability entry.
 *
 * @experimental
 */
export interface StudioCapabilityEntry {
  readonly id: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly version?: string;
  readonly constraints?: readonly StudioCapabilityConstraint[];
  readonly [extra: string]: unknown;
}

/**
 * The capability manifest a server returns describing supported package
 * families and feature capabilities.
 *
 * @experimental
 */
export interface StudioCapabilityManifest {
  readonly manifestId?: string;
  readonly version?: string;
  readonly serverVersion?: string;
  readonly capabilities: readonly StudioCapabilityEntry[];
  readonly packageFamilies?: readonly string[];
  readonly [extra: string]: unknown;
}

/**
 * Return the capability entry with the given id, or `undefined` if the
 * manifest does not advertise it (regardless of enabled state).
 *
 * @experimental
 */
export function getCapability(manifest: StudioCapabilityManifest, id: string): StudioCapabilityEntry | undefined {
  return manifest.capabilities.find((entry) => entry.id === id);
}

/**
 * Return `true` when the manifest advertises an enabled capability with the
 * given id.
 *
 * @experimental
 */
export function hasCapability(manifest: StudioCapabilityManifest, id: string): boolean {
  return manifest.capabilities.some((entry) => entry.id === id && entry.enabled);
}
