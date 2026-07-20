import type {
  ProtocolModule,
  ProtocolModuleHandle,
  SourceDescriptor,
} from "../../../../src/contract/index.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../../../../src/contract/index.js";
import type { CloudTilesDescription, CloudTilesReaderLike } from "./fake-cloud-tiles-reader.js";

/**
 * Handle returned by `Source.protocol("cloud-tiles")` in a real out-of-tree
 * integration. This fixture only needs `describe()` to prove the seam.
 */
export interface CloudTilesArchiveHandle {
  readonly url: string;
  describe(): Promise<CloudTilesDescription>;
}

function requireCloudTilesLocator(descriptor: SourceDescriptor): string {
  const { url } = descriptor.locator;
  if (typeof url !== "string" || url === "") {
    throw new Error(`cloud-tiles: source "${descriptor.id}" requires locator.url`);
  }
  return url;
}

/**
 * An out-of-tree-style `ProtocolModule` (issue #538 REQ-004): it implements
 * exactly the same public seam as `pmtilesProtocolModule()`
 * (`src/contract/pmtiles.ts`) — `kind`, `environments`, `capabilities()`,
 * `discover()` — while sharing no implementation with it and importing no
 * SDK internals beyond the public `ProtocolModule` type and
 * `PROTOCOL_DEFAULT_CAPABILITIES.pmtiles` (reused only because this fixture
 * models the same tiles-only capability vocabulary; a real independent
 * package would declare its own default capability set).
 */
export function cloudTilesProtocolModule(reader: CloudTilesReaderLike): ProtocolModule<"cloud-tiles", CloudTilesArchiveHandle> {
  return Object.freeze({
    kind: "cloud-tiles" as const,
    environments: Object.freeze(["browser", "node", "worker"] as const),
    capabilities() {
      return PROTOCOL_DEFAULT_CAPABILITIES.pmtiles;
    },
    discover(descriptor: SourceDescriptor): ProtocolModuleHandle<CloudTilesArchiveHandle> {
      const url = requireCloudTilesLocator(descriptor);
      let cached: Promise<CloudTilesDescription> | undefined;
      const adapter: CloudTilesArchiveHandle = {
        url,
        describe() {
          if (!cached) cached = reader.describe(url);
          return cached;
        },
      };
      return Object.freeze({
        descriptor,
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
        adapter,
        diagnostics: Object.freeze([]),
        dispose() {
          // No open resources between describe() calls.
        },
      });
    },
  });
}
