---
type: reference
title: "Studio AI proxy event casing"
description: "The signed stop-reason spelling, SSE event discriminants, and bounded aliases in the Studio agent contract."
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# Studio AI proxy event casing

`@honua/sdk-js/studio-agent` preserves the server's stop-reason spelling. The
public `StudioAiStopReason` type accepts these established values:

| Meaning | Honua server value | Existing SDK alias |
| --- | --- | --- |
| Normal turn completion | `EndTurn` | `endTurn` |
| Tool call | `ToolCall` | `toolCall` |
| Token limit | `MaxTokens` | `maxTokens` |
| Content filtering | `ContentFilter` | `contentFilter` |
| Cancellation | `Cancelled` | `cancelled` |
| Failure | `Error` | `error` |

The server's JSON property naming policy makes object keys camelCase, such as
`stopReason`. Its string enum converter preserves enum identifiers, such as
`EndTurn`. These are separate rules. The
[server JSON context](https://github.com/honua-io/honua-server/blob/81346cbe1b85913f065046a3dba66df3a5de8a53/src/Honua.Ai/Features/StudioAiProxy/StudioAiProxyJsonContext.cs)
and [enum definitions](https://github.com/honua-io/honua-server/blob/81346cbe1b85913f065046a3dba66df3a5de8a53/src/Honua.Ai/Features/StudioAiProxy/Domain/StudioAiChatEvent.cs)
define that wire format.

`SseChatTransport` obtains the SDK's camelCase event `type` from the separate
snake_case SSE event name: `event: message_stop` becomes `type: "messageStop"`.
It leaves `stopReason` and other payload values unchanged.

Signed transcripts bind the original provider-event values. Do not lowercase or
rewrite an event before verification. A consumer may compare known aliases
without mutating the received payload:

```ts doc-test=compile
import type { StudioAiChatEvent } from "@honua/sdk-js/studio-agent";

function endedNormally(event: StudioAiChatEvent): boolean {
  return event.stopReason === "EndTurn" || event.stopReason === "endTurn";
}
```

A recognized value is not proof of successful completion or authorization to
execute tools. Token limits, filtering, cancellation, and errors retain their
separate meanings; signed action rounds still require transcript verification
and replay protection. Changing signed `ToolCall` to `toolCall` is a transcript
mismatch even though both spellings belong to the public type.

## Which sessions require certified provenance

Certified provenance is required only for a candidate-certification session:
one constructed with `certification` or `transcriptVerifier`. Those turns
dispatch a model-selected tool only after exactly one terminal verified
`transcriptProvenance` event.

An interactive end-user session sets neither. honua-server
`StudioAiProxyEndpoints.HandleChat` returns 403 when `Certification` is set
and the caller is not an admin. The session therefore omits `certification`
and dispatches the model's tool calls with no provenance event. Server Studio
RBAC still authorizes each `honua_studio_*` call. Browser Studio's live agent
uses that uncertified session for a non-admin end user. Candidate
qualification stays on the certified path, and only an admin caller can send
the certification binding.
