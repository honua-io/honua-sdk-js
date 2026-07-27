import type { PortableQueryCompiledV1 } from "./protocol-module.js";

export interface PortableQueryReaderCall {
  readonly endpoint: string;
  readonly compiled: PortableQueryCompiledV1;
  readonly signal?: AbortSignal;
}

/** Explicitly injected reader surface owned by the independent fixture package. */
export interface PortableQueryReaderLike {
  execute(call: PortableQueryReaderCall): Promise<ReadonlyArray<Record<string, unknown>>>;
  dispose(endpoint: string): void;
}

export interface FakePortableQueryReader extends PortableQueryReaderLike {
  readonly calls: PortableQueryReaderCall[];
  readonly disposedEndpoints: string[];
}

export function createFakePortableQueryReader(): FakePortableQueryReader {
  const calls: PortableQueryReaderCall[] = [];
  const disposedEndpoints: string[] = [];
  return {
    calls,
    disposedEndpoints,
    async execute(call) {
      calls.push(call);
      return [
        { id: 1, status: "open" },
        { id: 2, status: "closed" },
      ];
    },
    dispose(endpoint) {
      disposedEndpoints.push(endpoint);
    },
  };
}
