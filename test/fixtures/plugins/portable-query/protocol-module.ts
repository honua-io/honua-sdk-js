import {
  capabilities,
  type ProtocolModuleHandle,
  type ProtocolModuleQueryBinding,
  type ProtocolModuleQueryCompileInput,
  type ProtocolModuleQueryExecuteInput,
  type QueryCapableProtocolModule,
  type SourceDescriptor,
} from "../../../../src/contract/index.js";
import type { PortableQueryReaderLike } from "./reader.js";

export interface PortableQuerySourceIdentity {
  readonly endpoint: string;
  readonly collection: string;
}

export interface PortableQueryIntent {
  readonly equals?: { readonly field: string; readonly value: string };
  readonly limit?: number;
}

export interface PortableQueryCompiledV1 {
  readonly compiler: "portable-query-v1";
  readonly endpoint: string;
  readonly collection: string;
  readonly params: readonly (readonly [string, string])[];
}

export interface PortableQueryExecutionContext {
  readonly includeGeometry?: boolean;
}

export interface PortableQueryBinding extends ProtocolModuleQueryBinding {
  readonly source: PortableQuerySourceIdentity;
  readonly compileQuery: PortableQueryIntent;
  readonly compiled: PortableQueryCompiledV1;
  readonly executeQuery: PortableQueryExecutionContext;
}

export interface PortableQueryAdapter {
  readonly endpoint: string;
  readonly collection: string;
}

export type PortableQueryModule = QueryCapableProtocolModule<
  "portable-query",
  PortableQueryAdapter,
  PortableQueryBinding
>;

/**
 * Independent query-capable module using public SDK types only. It shares no
 * compiler, executor, adapter, or registry implementation with first-party
 * OData.
 */
export function portableQueryProtocolModule(reader: PortableQueryReaderLike): PortableQueryModule {
  return Object.freeze({
    kind: "portable-query" as const,
    environments: Object.freeze(["browser", "node", "worker"] as const),
    capabilities() {
      return capabilities(["query"]);
    },
    discover(
      descriptor: SourceDescriptor<"portable-query">,
    ): ProtocolModuleHandle<PortableQueryAdapter, "portable-query"> {
      const endpoint = credentialFreeEndpoint(descriptor.locator.url);
      const collection = descriptor.locator.collectionId;
      if (typeof collection !== "string" || collection.length === 0) {
        throw new Error("portable-query: locator.collectionId is required");
      }
      let disposed = false;
      return Object.freeze({
        descriptor,
        capabilities: capabilities(["query"]),
        adapter: Object.freeze({ endpoint, collection }),
        diagnostics: Object.freeze([]),
        dispose() {
          if (disposed) return;
          disposed = true;
          reader.dispose(endpoint);
        },
      });
    },
    compile(
      input: ProtocolModuleQueryCompileInput<PortableQuerySourceIdentity, PortableQueryIntent>,
    ): PortableQueryCompiledV1 {
      const endpoint = credentialFreeEndpoint(input.source.endpoint);
      if (!input.source.collection) throw new Error("portable-query: collection is required");
      const params: Array<readonly [string, string]> = [];
      if (input.query.equals) {
        params.push(["field", input.query.equals.field], ["equals", input.query.equals.value]);
      }
      if (input.query.limit !== undefined) params.push(["limit", String(input.query.limit)]);
      params.sort(([left], [right]) => left.localeCompare(right));
      return Object.freeze({
        compiler: "portable-query-v1" as const,
        endpoint,
        collection: input.source.collection,
        params: Object.freeze(params),
      });
    },
    async execute<TRecord>(
      handle: ProtocolModuleHandle<PortableQueryAdapter, "portable-query">,
      input: ProtocolModuleQueryExecuteInput<PortableQueryCompiledV1, PortableQueryExecutionContext>,
    ) {
      if (input.operation === "queryAggregate") {
        throw new Error("portable-query: queryAggregate is not supported");
      }
      if (
        input.compiled.endpoint !== handle.adapter.endpoint ||
        input.compiled.collection !== handle.adapter.collection
      ) {
        throw new Error("portable-query: compiled identity does not match the discovered handle");
      }
      const rows = await reader.execute({
        endpoint: handle.adapter.endpoint,
        compiled: input.compiled,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const limit =
        input.operation === "query" && input.compiled.params.find(([name]) => name === "limit")
          ? Number(input.compiled.params.find(([name]) => name === "limit")?.[1])
          : undefined;
      const selected = typeof limit === "number" && Number.isFinite(limit) ? rows.slice(0, limit) : rows;
      return {
        features: selected.map((attributes) => ({
          attributes: attributes as TRecord,
          geometry: input.query.includeGeometry ? { type: "Point", coordinates: [0, 0] } : null,
        })),
        exceededTransferLimit: selected.length < rows.length,
        totalCount: rows.length,
      };
    },
  });
}

function credentialFreeEndpoint(value: string | undefined): string {
  if (!value) throw new Error("portable-query: locator.url is required");
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("portable-query: endpoint must not contain credentials, query, or fragment");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}
