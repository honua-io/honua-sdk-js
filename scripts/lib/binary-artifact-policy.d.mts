export function forbiddenBinaryArtifactReason(file: string, prefix?: Uint8Array): string | undefined;

export function scanBinaryArtifactFiles(options: {
  root: string;
  paths: readonly string[];
}): Array<{ file: string; reason: string }>;
