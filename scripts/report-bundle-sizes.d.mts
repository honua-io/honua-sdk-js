export interface SizeSample {
  min: number;
  gzip: number;
}

export interface BudgetRow {
  key: string;
  measured: SizeSample;
  budget: SizeSample;
  minDelta: number;
  gzipDelta: number;
  overBudget: boolean;
}

export interface BudgetEvaluation {
  rows: BudgetRow[];
  failures: BudgetRow[];
  missingBudget: string[];
}

export function evaluateBudgets(
  measurements: Record<string, SizeSample>,
  budgets: Record<string, SizeSample>,
): BudgetEvaluation;
