/** Compile-only proof of the implemented kernel connect/inspect/explain/query/mount slice. */
import { type ConnectionInspection, type HonuaKernelConnection, createHonua } from "../../../src/index.js";
import { type MapLibreRendererPeer, maplibreRenderer } from "../../../src/runtime/index.js";

declare const maplibrePeer: MapLibreRendererPeer;

interface Parcel {
  readonly id: string;
  readonly status: string;
}

export async function inspectManagedConnection(signal: AbortSignal): Promise<ConnectionInspection> {
  const honua = createHonua({
    capabilityPolicy: { allow: ["query"], deny: ["applyEdits"] },
    discoveryCacheMaxEntries: 64,
  });
  const connection: HonuaKernelConnection<Parcel> = await honua.connect({
    url: "https://example.test/ogc/features",
    protocol: "ogc-features",
    sourceId: "parcels",
  });
  const inspection = await connection.inspect({ refresh: true, signal });
  const source = connection.source();

  inspection.sources satisfies readonly unknown[];
  connection.sourceDescriptors satisfies readonly unknown[];
  source.descriptor.id satisfies string;

  // @ts-expect-error Immutable snapshots do not expose array mutation.
  inspection.sources.push(inspection.sources[0]);
  const plan = await connection.explain({ pagination: { limit: 100 } }, { signal });
  const result = await connection.query(plan, { signal });
  plan.fingerprint satisfies `sha256:${string}`;
  result.execution.terminal.state satisfies "completed";
  const mounted = await connection.mount("#map", {
    renderer: maplibreRenderer(maplibrePeer),
    style: "auto",
  });
  await mounted.ready;
  mounted.raw("maplibre")?.triggerRepaint?.();
  await mounted.dispose();

  await connection.dispose();
  await honua.dispose();
  return inspection;
}
