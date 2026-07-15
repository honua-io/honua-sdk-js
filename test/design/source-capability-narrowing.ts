import type { CapabilityAwareSource, SourceWithCapability } from "../../src/contract/index.js";
import type { CapabilityId } from "../../src/source-capabilities.js";

declare const source: CapabilityAwareSource<{ id: number }>;

declare function requiresQuery(value: SourceWithCapability<{ id: number }, "query">): void;
declare function requiresEdits(value: SourceWithCapability<{ id: number }, "applyEdits">): void;

// @ts-expect-error A capability-aware source has no proof before the runtime check.
requiresQuery(source);

if (source.supports("query")) {
  requiresQuery(source);
  // @ts-expect-error Query support does not imply edit support.
  requiresEdits(source);
}

if (source.supports("query") && source.supports("applyEdits")) {
  requiresQuery(source);
  requiresEdits(source);
}

declare const dynamicCapability: CapabilityId;
if (source.supports(dynamicCapability)) {
  // @ts-expect-error Checking a dynamic union is not proof of one specific capability.
  requiresQuery(source);
}
