export interface PrFastOptions {
  budgetMs: number;
  output: string;
  startedAtMonotonicMs: number;
}

export function parseArgs(argv: readonly string[]): PrFastOptions;
