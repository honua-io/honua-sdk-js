export const SAMPLE_CONTRACT_PATHS: readonly string[];
export interface SampleContractArtifactReceipt {
  readonly schema: "honua.sample-contract-artifact/v1";
  readonly sourceRevision: string;
  readonly sourceDirty: boolean;
  readonly sdkVersion: string;
  readonly filename: string;
  readonly sha256: string;
  readonly integrity: string;
  readonly compressedBytes: number;
  readonly unpackedBytes: number;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly node: string;
}
export function packSampleContractArtifact(options: {
  readonly projectRoot: string;
  readonly outputDirectory: string;
}): Promise<SampleContractArtifactReceipt>;
