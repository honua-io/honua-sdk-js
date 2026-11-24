import type { EditOutcome, EditResult } from "./types.js";

export function canonicalEditResult(response: import("../core/types.js").HonuaApplyEditsResponse): EditResult {
  return {
    added: (response.addResults ?? []).map(toEditOutcome),
    updated: (response.updateResults ?? []).map(toEditOutcome),
    deleted: (response.deleteResults ?? []).map(toEditOutcome),
  };
}

function toEditOutcome(result: import("../core/types.js").HonuaEditResult): EditOutcome {
  const out: EditOutcome = { success: result.success };
  if (typeof result.globalId === "string" && result.globalId.length > 0) {
    out.globalId = result.globalId;
  }
  if (
    typeof result.objectId === "string" ||
    (typeof result.objectId === "number" && Number.isFinite(result.objectId))
  ) {
    out.id = result.objectId;
  }
  if (result.error) {
    out.error = { code: result.error.code, description: result.error.description };
  }
  return out;
}
