import type { ModelDriver, Scenario, TranscriptStep, WorkflowContext, WorkflowTranscript } from "../types.js";

/**
 * Deterministic offline driver — the CI control for the cross-model eval.
 *
 * It does not call any model. Instead it executes the scenario's scripted "ideal
 * client" tool trajectory against the REAL MCP surface (the same `tools/call`
 * round-trips a live LLM would make), then synthesizes a final answer from the
 * concatenated tool results. This makes the offline eval a genuine end-to-end
 * exercise of the MCP surface — not a stub — while staying fully reproducible.
 */
export class DeterministicDriver implements ModelDriver {
  readonly id = "deterministic";
  readonly vendor = "deterministic" as const;

  isAvailable(): boolean {
    return true;
  }

  async runWorkflow(scenario: Scenario, ctx: WorkflowContext): Promise<WorkflowTranscript> {
    const advertised = new Set(ctx.tools.map((t) => t.name));
    const steps: TranscriptStep[] = [];
    const answerParts: string[] = [];
    let errorCount = 0;

    for (const planned of scenario.script) {
      if (!advertised.has(planned.tool)) {
        // The scripted tool is not on the surface — record a driver-visible error
        // (a real catalog regression would surface here, not silently pass).
        return {
          scenarioId: scenario.id,
          modelId: this.id,
          steps,
          finalAnswer: answerParts.join("\n"),
          clarificationRequested: false,
          errorCount,
          driverError: `scripted tool not advertised by the MCP surface: ${planned.tool}`,
        };
      }

      const result = await ctx.callTool(planned.tool, planned.args);
      steps.push({ tool: planned.tool, args: planned.args, isError: result.isError });
      if (result.isError) {
        errorCount++;
      }
      answerParts.push(result.text);
    }

    return {
      scenarioId: scenario.id,
      modelId: this.id,
      steps,
      finalAnswer: answerParts.join("\n"),
      clarificationRequested: false,
      errorCount,
    };
  }
}
