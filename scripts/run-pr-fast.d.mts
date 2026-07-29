export interface PrFastOptions {
  budgetMs: number;
  output: string;
  startedAtMonotonicMs: number;
}

export interface PrFastCommandRuntime {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  execPath?: string;
  existsSync?: (path: string) => boolean;
  platform?: string;
  statSync?: (path: string) => { isFile(): boolean };
}

export interface PrFastCommandInvocation {
  command: string;
  args: readonly string[];
}

export function commandInvocation(
  command: string,
  args: readonly string[],
  runtime?: PrFastCommandRuntime,
): PrFastCommandInvocation;

export function parseArgs(argv: readonly string[]): PrFastOptions;
