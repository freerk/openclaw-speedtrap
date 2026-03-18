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

## Solution: channelId + conversationId from hook context

All hooks now receive `channelId` and `conversationId` via their context
(`PluginHookAgentContext`, `PluginHookToolContext`, or event fields).
Speedtrap builds its channel key from these two fields, skipping `accountId`:

```typescript
buildPhysicalChannelKey(channelId, conversationId);
// "slack" + "channel:C0AJN2H5YQ5" → "slack:channel:C0AJN2H5YQ5"
```

This produces the same key regardless of which bot account is used,
with no string parsing or assumptions about channelKey format.

### Core fields used

| Hook                   | channelId source  | conversationId source  |
| ---------------------- | ----------------- | ---------------------- |
| `message_received`     | `ctx.channelId`   | `ctx.conversationId`   |
| `before_agent_start`   | `ctx.channelId`   | `ctx.conversationId`   |
| `before_tool_call`     | `ctx.channelId`   | `ctx.conversationId`   |
| `after_agent_complete` | `event.channelId` | `event.conversationId` |
