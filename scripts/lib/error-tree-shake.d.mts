export interface ErrorTreeShakeFixture {
  readonly key: string;
  readonly entry: string;
  readonly requiredModules: readonly string[];
  readonly forbiddenModules: readonly string[];
}

export const ERROR_LEAF_FORBIDDEN_MODULES: readonly string[];
export const ERROR_TREE_SHAKE_FIXTURES: readonly ErrorTreeShakeFixture[];

export function normalizeRetainedModule(input: string): string;
export function retainedMetafileInputs(metafile: {
  readonly outputs: Readonly<
    Record<string, { readonly inputs?: Readonly<Record<string, { readonly bytesInOutput: number }>> }>
  >;
}): string[];
export function errorModulePolicyFailures(
  key: string,
  inputs: readonly string[],
  requiredModules?: readonly string[],
  forbiddenModules?: readonly string[],
): { readonly retained: readonly string[]; readonly failures: readonly string[] };
