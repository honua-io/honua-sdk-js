/**
 * Compile-only proof for issue #671 REQ-001: a third-party `ProtocolModule`
 * with a custom protocol kind (not a member of the built-in `Protocol`
 * union — mirroring the cloud-tiles fixture's `"cloud-tiles"`,
 * `test/fixtures/plugins/cloud-tiles/protocol-module.ts`) must be callable
 * with a `SourceDescriptor` typed to that kind without an `as`/`as unknown`
 * cast. No vitest assertions live here; `npm run typecheck` is the check —
 * see `test/query-planner-semantic-negative.ts` for the established pattern
 * of a standalone compile-proof file relying only on `tsc`.
 */
import type {
  Capabilities,
  Protocol,
  ProtocolModule,
  ProtocolModuleHandle,
  SourceDescriptor,
} from "../src/contract/index.js";
import { capabilities } from "../src/contract/index.js";

interface CustomTilesAdapter {
  readonly url: string;
  describe(): Promise<{ readonly tileCount: number }>;
}

/** An out-of-tree-style module carrying a protocol id the SDK never declares. */
const customTilesModule: ProtocolModule<"cloud-tiles", CustomTilesAdapter> = {
  kind: "cloud-tiles",
  environments: ["browser", "node", "worker"],
  capabilities(): Capabilities {
    return capabilities(["tiles"]);
  },
  discover(descriptor): ProtocolModuleHandle<CustomTilesAdapter, "cloud-tiles" | Protocol> {
    const url = descriptor.locator.url;
    return {
      descriptor,
      capabilities: capabilities(["tiles"]),
      adapter: {
        url,
        async describe() {
          return { tileCount: 0 };
        },
      },
      diagnostics: [],
      dispose() {},
    };
  },
};

/** Compile proof: a descriptor typed to the module's own custom kind needs no cast. */
export async function customKindDescriptorTypechecks(): Promise<void> {
  const descriptor: SourceDescriptor<"cloud-tiles"> = {
    id: "custom-basemap",
    protocol: "cloud-tiles",
    locator: { url: "https://tiles.example.test/custom.tiles" },
    capabilities: capabilities(["tiles"]),
  };

  const handle = customTilesModule.discover(descriptor);
  const resolved = handle instanceof Promise ? await handle : handle;
  resolved.descriptor.protocol satisfies "cloud-tiles" | Protocol;
  await resolved.adapter.describe();
  await resolved.dispose();

  // A built-in `SourceDescriptor` (protocol: Protocol) is also accepted —
  // the module admits its own kind *in addition to*, not instead of, the
  // built-in union.
  const builtIn: SourceDescriptor = {
    id: "built-in-pmtiles",
    protocol: "pmtiles",
    locator: { url: "https://tiles.example.test/basemap.pmtiles" },
    capabilities: capabilities(["tiles"]),
  };
  customTilesModule.discover(builtIn);

  customTilesModule.discover({
    id: "wrong-kind",
    // @ts-expect-error A descriptor for an unrelated protocol id is neither
    // this module's own kind nor a built-in `Protocol`.
    protocol: "not-a-real-protocol",
    locator: { url: "https://tiles.example.test/wrong.tiles" },
    capabilities: capabilities([]),
  });
}
