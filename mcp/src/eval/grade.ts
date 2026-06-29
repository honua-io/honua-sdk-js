import type { Scenario, ScenarioGrade, WorkflowTranscript } from "./types.js";

/** True if `sequence` appears as an ordered (not necessarily contiguous) subsequence of `steps`. */
export function isOrderedSubsequence(steps: string[], sequence: string[]): boolean {
  let i = 0;
  for (const step of steps) {
    if (i < sequence.length && step === sequence[i]) {
      i++;
    }
  }
  return i === sequence.length;
}

/**
 * Grade a transcript against a scenario's declarative success criteria.
 *
 * Outcomes:
 *  - `error`: the driver failed to run (unavailable model, exception).
 *  - `clarified`: the driver asked a clarifying question instead of completing.
 *  - `pass`: all criteria satisfied.
 *  - `fail`: completed but violated one or more criteria.
 */
export function grade(scenario: Scenario, transcript: WorkflowTranscript): ScenarioGrade {
  const base = {
    scenarioId: scenario.id,
    modelId: transcript.modelId,
    errorCount: transcript.errorCount,
  };

  if (transcript.driverError) {
    return { ...base, outcome: "error", violations: [transcript.driverError] };
  }
  if (transcript.clarificationRequested) {
    return { ...base, outcome: "clarified", violations: ["driver requested clarification"] };
  }

  const violations: string[] = [];
  const calledTools = transcript.steps.map((s) => s.tool);
  const calledSet = new Set(calledTools);
  const { criteria } = scenario;

  for (const required of criteria.requiredTools) {
    if (!calledSet.has(required)) {
      violations.push(`required tool not called: ${required}`);
    }
  }

  if (criteria.expectedToolSequence && !isOrderedSubsequence(calledTools, criteria.expectedToolSequence)) {
    violations.push(`expected tool sequence not observed: ${criteria.expectedToolSequence.join(" -> ")}`);
  }

  for (const forbidden of criteria.forbiddenTools ?? []) {
    if (calledSet.has(forbidden)) {
      violations.push(`forbidden tool called: ${forbidden}`);
    }
  }

  const answer = transcript.finalAnswer.toLowerCase();
  for (const fragment of criteria.answerMustInclude ?? []) {
    if (!answer.includes(fragment.toLowerCase())) {
      violations.push(`answer missing expected content: "${fragment}"`);
    }
  }

  return { ...base, outcome: violations.length === 0 ? "pass" : "fail", violations };
}
