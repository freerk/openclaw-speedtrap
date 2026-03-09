# Speedtrap — Discard Stale Agent Responses

Speedtrap prevents **thundering herd** and **cascade** behavior in multi-agent channels. The core insight: if the channel moved while an agent was thinking, its response is stale — drop it.

## The Problem

With N agents on the same channel:

1. Message arrives → all N agents process it concurrently
2. All N produce responses → channel flood
3. Agent responses trigger other agents → cascading loop

## How It Works

All agents receive all messages and process them normally. When an agent finishes, before delivery, Speedtrap checks: have new messages appeared on the channel since this agent started processing?

| Channel moved? | Write side effects? | Outcome                                                                |
| -------------- | ------------------- | ---------------------------------------------------------------------- |
| No             | —                   | **deliver** — response is fresh                                        |
| Yes            | No                  | **suppress** — response is stale, discard it                           |
| Yes            | Yes                 | **reinject** — re-run so agent can revise while confirming what it did |

No buffering, no turn management, no special sentinel strings. The agent will get another chance naturally — new messages already triggered fresh runs through the normal pipeline.

### Write Side Effects

If an agent executed write operations (file writes, config changes, API calls) during its run, the side effects already happened. Silently discarding the response means nobody knows what was done. Instead, the agent is re-run with a prompt that includes its draft response and the write tools it invoked, so it can adapt its message to the current conversation while still confirming what it did.

Read-only tool calls (`memory_search`, `web_search`, `file_read`, etc.) are safe to discard — they have no side effects.

### Tool Classification

Tools are classified as read or write using:

1. A known list of read-only tools (search, fetch, list, read operations)
2. A prefix heuristic (`read_*`, `search_*`, `get_*`, `list_*`, `find_*`, `fetch_*`, etc.)
3. A configurable default for unknown tools (conservative default: assume write)

## What This Solves

- **Thundering herd**: 3 agents process the same message. Fastest delivers. The other 2 are discarded because the channel moved (the first agent's response is now on it).
- **Cascade prevention**: Agent responses trigger other agents, but those runs get discarded too. The cascade burns tokens but produces no output. It self-extinguishes.
- **Convergence**: Structural, not LLM-dependent. No reliance on agents deciding to be quiet.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "speedtrap": {
        "enabled": true,
        "config": {
          "assumeUnknownToolsAreWrites": true,
          "debug": true
        }
      }
    }
  }
}
```

| Key                           | Default | Description                                                                            |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `assumeUnknownToolsAreWrites` | `true`  | Unknown tools assumed to have write side effects (forces reinject instead of suppress) |
| `debug`                       | `true`  | Log all decisions to console                                                           |

## Architecture

```
Inbound message
  │
  ├─ message_received → update channel lastMessageTimestamp
  │
  ├─ before_agent_start → snapshot channel timestamp for this run
  │
  ├─ before_tool_call → classify tool as read/write, track writes
  │
  └─ after_agent_complete → compare snapshot vs current timestamp
        │
        ├─ unchanged → deliver
        ├─ moved + no writes → suppress
        └─ moved + writes → reinject with context
```

Four hooks. That's the entire plugin.

## Known Limitations

- **Token cost on cascades**: With `allowBots=true`, agent responses still trigger other agents. Those runs happen (LLM calls, tool calls). Their responses just get discarded. A future `suppressCascade` on `before_dispatch` could prevent these runs entirely, trading memory-building potential for cost savings.
- **Write reinjection is one-shot**: The reinjected run gets one chance to revise. If the channel moves again during reinjection, that response is evaluated fresh (delivered if channel is quiet, suppressed if it moved again with no new writes).
- **No inter-agent awareness**: Agents don't see each other's responses before delivering. The fastest agent wins; slower agents are discarded.
