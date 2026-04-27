/**
 * `MessageCatalog` — flat `id → string` map with ICU-lite placeholder
 * substitution (`{name}`). The catalog is the only place reference
 * components read user-facing strings from; embedders ship alternates
 * by passing a different catalog.
 *
 * @module
 */

export type MessageId =
  | "chat.placeholder"
  | "chat.send"
  | "chat.empty"
  | "clarification.title"
  | "clarification.submit"
  | "clarification.required"
  | "plan.title"
  | "plan.empty"
  | "plan.accept"
  | "plan.revise"
  | "plan.requiresApproval"
  | "plan.estimatedCost"
  | "execution.idle"
  | "execution.accepted"
  | "execution.running"
  | "execution.successful"
  | "execution.failed"
  | "execution.dismissed"
  | "map.empty"
  | "map.refine"
  | "builder.empty"
  | "builder.refine"
  | "approval.notRequired"
  | "approval.pending"
  | "approval.granted"
  | "approval.deferred"
  | "approval.denied"
  | "approval.confirm"
  | "approval.audit";

export type MessageCatalog = Partial<Record<MessageId, string>>;

export const DEFAULT_MESSAGES: Readonly<Record<MessageId, string>> = {
  "chat.placeholder": "Describe what you'd like to do…",
  "chat.send": "Send",
  "chat.empty": "No messages yet.",
  "clarification.title": "We need a few more details",
  "clarification.submit": "Continue",
  "clarification.required": "Required",
  "plan.title": "Proposed plan",
  "plan.empty": "No plan loaded.",
  "plan.accept": "Run plan",
  "plan.revise": "Revise plan",
  "plan.requiresApproval": "Requires approval",
  "plan.estimatedCost": "Estimated cost: ${amount}",
  "execution.idle": "Waiting to start.",
  "execution.accepted": "Queued.",
  "execution.running": "Running… {percent}%",
  "execution.successful": "Completed.",
  "execution.failed": "Failed: {message}",
  "execution.dismissed": "Cancelled.",
  "map.empty": "No map output yet.",
  "map.refine": "Refine map",
  "builder.empty": "No app preview yet.",
  "builder.refine": "Refine app",
  "approval.notRequired": "No approval required.",
  "approval.pending": "Approval pending.",
  "approval.granted": "Approved.",
  "approval.deferred": "Approval deferred.",
  "approval.denied": "Denied: {reason}",
  "approval.confirm": "Approve",
  "approval.audit": "Audit",
};

/**
 * Resolve a message id to a string with ICU-lite `{placeholder}`
 * substitution. Falls back to `DEFAULT_MESSAGES` when an id is not
 * present in the supplied catalog. Unknown placeholders survive
 * unrendered so missing data is visible rather than silently empty.
 */
export function resolveMessage(
  catalog: MessageCatalog | undefined,
  id: MessageId,
  values?: Readonly<Record<string, string | number>>,
): string {
  const template = catalog?.[id] ?? DEFAULT_MESSAGES[id];
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const v = values[key];
    return v === undefined ? match : String(v);
  });
}
