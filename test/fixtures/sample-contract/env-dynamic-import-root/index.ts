function selectImportMetaRoot(): string {
  return Date.now() > 0 ? "env" : "url";
}

const root = selectImportMetaRoot();
export const dynamicImportMetaRoot = import.meta[root];
