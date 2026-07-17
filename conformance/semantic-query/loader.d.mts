export interface LoadSemanticQueryCorpusOptions {
  readonly schemaUrl?: URL;
  readonly corpusUrl?: URL;
}

export class SemanticQueryCorpusError extends Error {}

export function loadSemanticQueryCorpus(options?: LoadSemanticQueryCorpusOptions): Promise<unknown>;

export function validateSemanticQueryCorpus(schema: unknown, corpus: unknown): unknown;
