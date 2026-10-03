export interface MissingRelativeImport {
  readonly file: string;
  readonly specifier: string;
}

/** Relative import specifiers in one module. Package names and non-literal dynamic imports are ignored. */
export function relativeImportSpecifiers(source: string): string[];

/** Relative imports whose target file is not inside the copied package. */
export function missingRelativeImports(packageRoot: string): MissingRelativeImport[];
