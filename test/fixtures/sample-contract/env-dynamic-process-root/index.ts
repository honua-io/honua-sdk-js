function selectProcessRoot(): string {
  return Date.now() > 0 ? "env" : "argv";
}

const root = selectProcessRoot();
export const dynamicProcessRoot = process[root];
