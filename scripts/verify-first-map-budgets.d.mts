export interface FirstMapBudgetMeasurement {
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface FirstMapBudgetReport {
  readonly files: number;
  readonly javascript: FirstMapBudgetMeasurement;
  readonly css: FirstMapBudgetMeasurement;
  readonly total: FirstMapBudgetMeasurement;
}

export declare function verifyFirstMapBudgets(): FirstMapBudgetReport;
