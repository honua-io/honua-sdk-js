export interface BundleMeasurement {
  readonly min: number;
  readonly gzip: number;
  readonly errorModules?: readonly string[];
}

export interface BundleBudget {
  readonly min: number;
  readonly gzip: number;
}

export interface BundleBudgetRow {
  readonly key: string;
  readonly measured: BundleMeasurement;
  readonly budget: BundleBudget;
  readonly minDelta: number;
  readonly gzipDelta: number;
  readonly overBudget: boolean;
}

export function evaluateBudgets(
  measurements: Readonly<Record<string, BundleMeasurement>>,
  budgets: Readonly<Record<string, BundleBudget>>,
): {
  readonly rows: readonly BundleBudgetRow[];
  readonly failures: readonly BundleBudgetRow[];
  readonly missingBudget: readonly string[];
};

export function evaluateErrorNfrReductions(
  measurements: Readonly<Record<string, Pick<BundleMeasurement, "gzip">>>,
  baselines?: Readonly<Record<string, number>>,
): {
  readonly rows: readonly {
    readonly key: string;
    readonly baseline: number;
    readonly measured: number;
    readonly ceiling: number;
    readonly reduction: number;
  }[];
  readonly failures: readonly ({ readonly key: string; readonly reason: string } | {
    readonly key: string;
    readonly baseline: number;
    readonly measured: number;
    readonly ceiling: number;
    readonly reduction: number;
  })[];
};
