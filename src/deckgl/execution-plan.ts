import type {
  DeckGlExecutionAvailability,
  DeckGlExecutionPlan,
  DeckGlExecutionPlanRequest,
  DeckGlExecutionStrategy,
} from "./types.js";

const DEFAULT_PREFERENCE: readonly DeckGlExecutionStrategy[] = ["gpu-binary"];

/**
 * Select an execution lane from caller-supplied facts without probing a device
 * or importing an optional renderer. The SDK owns only the binary lane;
 * object and tile lanes remain caller-owned fallbacks.
 */
export function planDeckGlExecution(request: DeckGlExecutionPlanRequest): DeckGlExecutionPlan {
  const preferred = request.preferred?.length ? request.preferred : DEFAULT_PREFERENCE;
  const availability: DeckGlExecutionAvailability = request.availability ?? { gpuBinary: true };
  const primary = preferred[0] ?? "gpu-binary";

  for (const strategy of preferred) {
    if (!isAvailable(strategy, availability)) continue;
    return {
      layer: request.layer,
      execution: strategy,
      fallback: strategy === primary ? "none" : strategy,
      fidelity:
        strategy === "gpu-binary" ? "exact-input" : strategy === "cpu-object" ? "bounded-object" : "tile-bounded",
      ownership: strategy === "gpu-binary" ? "sdk" : "caller",
      reason:
        strategy === "gpu-binary"
          ? "The SDK binary projection lane is available from explicit capability facts."
          : `The caller supplied the ${strategy} fallback lane.`,
    };
  }

  return {
    layer: request.layer,
    execution: "unsupported",
    fallback: "none",
    fidelity: "unsupported",
    ownership: "none",
    reason: "No preferred execution lane is available from the caller-supplied capability facts.",
  };
}

function isAvailable(strategy: DeckGlExecutionStrategy, availability: DeckGlExecutionAvailability): boolean {
  if (strategy === "gpu-binary") return availability.gpuBinary === true;
  if (strategy === "cpu-object") return availability.cpuObject === true;
  return availability.tile === true;
}
