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

```ts
const endedNormally = event.stopReason === "EndTurn" || event.stopReason === "endTurn";
```

A recognized value is not proof of successful completion or authorization to
execute tools. Token limits, filtering, cancellation, and errors retain their
separate meanings; signed action rounds still require transcript verification
and replay protection. Changing signed `ToolCall` to `toolCall` is a transcript
mismatch even though both spellings belong to the public type.
