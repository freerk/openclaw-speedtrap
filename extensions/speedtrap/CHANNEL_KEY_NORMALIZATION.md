# Channel Key Normalization

## Problem

Core builds `channelKey` as `[provider, accountId, destination].join(":")`.

In multi-agent setups, each agent uses a different bot account for the same
provider. This produces different channelKeys for the same physical channel:

- `slack:default:channel:C0AJN2H5YQ5` (agent "main")
- `slack:conor:channel:C0AJN2H5YQ5` (agent "conor")

Speedtrap needs to treat these as the same channel for stale-response
detection. If it doesn't, agents on different accounts can't see each other's
activity, and herd suppression is bypassed entirely.

## Current fix (Option A): strip accountId in the extension

In `message_received`, we build the key from `channelId` + `conversationId`,
skipping `accountId`:

```typescript
buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
// "slack" + "channel:C0AJN2H5YQ5" → "slack:channel:C0AJN2H5YQ5"
```

In `after_agent_complete`, we strip the accountId segment from the core-built
`event.channelKey`:

```typescript
stripAccountFromChannelKey("slack:conor:channel:C0AJN2H5YQ5", "slack");
// → "slack:channel:C0AJN2H5YQ5"
```

**Assumption:** accountId is always a single segment (no colons). This holds
for all known providers today (Slack, Telegram, WhatsApp, Discord, Teams,
Matrix, iMessage, Zalo, Signal, Voice).

## Better fix (Option B): pass components in `after_agent_complete` event

Add `conversationId` (or `to`) as a separate field on
`PluginHookAfterAgentCompleteEvent` in core (`src/plugins/types.ts`):

```typescript
export type PluginHookAfterAgentCompleteEvent = {
  sessionKey: string;
  channelId: string;
  channelKey: string;
  conversationId?: string; // ← new field: destination without accountId
  agentId: string;
  response: string;
  // ...
};
```

The extension would then build the physical key cleanly in both hooks:

```typescript
// message_received
buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);

// after_agent_complete
buildPhysicalChannelKey(event.channelId, event.conversationId);
```

No string parsing, no assumptions about channelKey format, works for any
provider regardless of how accountId is structured.

### Core change required

In `src/auto-reply/reply/agent-runner.ts`, where the `after_agent_complete`
event is built, add `conversationId: sessionCtx.To` (or equivalent) to the
event payload. The value is already available in the template context.
