export interface TestBuildOwnershipViolation {
  file: string;
  line: number;
  column: number;
  reason: string;
}

export function analyzeTestBuildOwnership(options: {
  projectRoot: string;
  testRoot?: string;
}): TestBuildOwnershipViolation[];
export function assertTestBuildOwnership(options: {
  projectRoot: string;
  testRoot?: string;
}): { filesChecked: number };
