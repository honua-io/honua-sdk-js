/** Compile-only proof of the implemented #532 kernel slice. */
import { type ConnectionInspection, type HonuaKernelConnection, createHonua } from "../../../src/index.js";

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
  // @ts-expect-error The query facade belongs to a later implementation issue.
  connection.query({});
  // @ts-expect-error Renderer mounting belongs to a later implementation issue.
  connection.mount("#map", {});

  await connection.dispose();
  await honua.dispose();
  return inspection;
}
