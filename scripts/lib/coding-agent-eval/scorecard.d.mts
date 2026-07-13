import type { LaneResult, TaskScore } from "./runner.mjs";

export interface Scorecard {
  schemaVersion: number;
  generatedAt: string;
  repo: { sha: string; source: string };
  lane: string;
  adapter: { name: string; variant?: string; model: string; version: string };
  summary: { tasks: number; skipped: number; passed: number; failed: number; passRate: number };
  tasks: TaskScore[];
}

export declare const SCORECARD_SCHEMA_VERSION: number;
export declare const PUBLISHED_SCORECARD_PATH: string;
export declare function buildScorecard(options: {
  repoRoot: string;
  lane: string;
  laneResult: LaneResult;
  generatedAt?: string;
}): Scorecard;
export declare function renderScorecardMarkdown(scorecard: Scorecard): string;
export declare function publishScorecard(options: { repoRoot: string; scorecards: Scorecard[] }): string;
