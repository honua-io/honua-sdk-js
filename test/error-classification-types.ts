import {
  withHonuaErrorClassification,
  withHonuaErrorReasonClassification,
  withStructuredHonuaErrorClassification,
} from "../src/core/error-base.js";

void withHonuaErrorClassification({}, "core.cancelled", "HonuaAbortError", "core", "cancellation", false);
void withStructuredHonuaErrorClassification({}, "core.network", "HonuaNetworkError", "core", "network", true);
void withHonuaErrorReasonClassification(
  {},
  "realtime.sequence.gap",
  "HonuaRealtimeResumeError",
  "realtime",
  "protocol",
  true,
  "sequence-gap",
);

// @ts-expect-error The canonical registry fixes the domain for each code.
void withHonuaErrorClassification({}, "core.cancelled", "HonuaAbortError", "map", "cancellation", false);
// @ts-expect-error Leaf names come from the explicit canonical name union.
void withHonuaErrorClassification({}, "core.cancelled", "HonuaUnregisteredWidgetError", "core", "cancellation", false);
// @ts-expect-error The canonical registry fixes the category for each code.
void withStructuredHonuaErrorClassification({}, "core.network", "HonuaNetworkError", "core", "validation", true);
void withHonuaErrorReasonClassification(
  {},
  "realtime.sequence.gap",
  "HonuaRealtimeResumeError",
  "realtime",
  "protocol",
  // @ts-expect-error The canonical registry fixes retryability for each code.
  false,
  "sequence-gap",
);
