export interface FixtureRefreshChange {
  before: string;
  after: string;
}

export interface FixtureRefreshReport {
  pack: string;
  manifest: string;
  checksumChanges: Array<{ name: string; before: string; after: string }>;
  metadataChanged: boolean;
  metadataChanges: Record<string, FixtureRefreshChange>;
  wroteChecksums: boolean;
  acceptedMetadata: boolean;
}

export function verifyFixturePacks(options?: {
  fixturesRoot?: string;
  requestedPack?: string;
  writeChecksums?: boolean;
  acceptMetadata?: boolean;
}): {
  report: { fixturePackReportVersion: 1; reports: FixtureRefreshReport[] };
  exitCode: 0 | 1;
};
