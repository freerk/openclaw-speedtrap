# Speedtrap — Coalesced Stale-Response Handling

Speedtrap prevents **thundering herd** and **cascade** behavior in multi-agent channels. The core insight: if the channel moved while an agent was thinking, its response is stale. Depending on what happened during the run, Speedtrap delivers, reinjects with context, or suppresses the response.

## Installation

### From npm

```sh
openclaw plugin install @openclaw/speedtrap
```

### Manual (monorepo)

The plugin lives at `extensions/speedtrap/`. If you're running from a git checkout, it's already available, just enable it in your config.

### Manual (standalone)

If you're running OpenClaw from a global npm install (e.g. on a VPS) and the plugin isn't on npm yet, you can clone it directly:

```sh
git clone https://github.com/openclaw/openclaw /tmp/openclaw-src
cp -r /tmp/openclaw-src/extensions/speedtrap ~/.openclaw/plugins/speedtrap
rm -rf /tmp/openclaw-src
```

Then register it in your config (`~/.openclaw/config.json`):

```json
{
  "plugins": {
    "entries": {
      "speedtrap": {
        "enabled": true,
        "path": "~/.openclaw/plugins/speedtrap"
      }
    }
  }
}
```

## Enable / Disable

```sh
# Enable
openclaw config set plugins.entries.speedtrap.enabled true

# Disable
openclaw config set plugins.entries.speedtrap.enabled false
```

Or edit your config file directly (`~/.openclaw/config.json`):

```json
{
  "plugins": {
    "entries": {
      "speedtrap": {
        "enabled": true
      }
    }
  }
}
```

## The Problem

With N agents on the same channel:

1. Message arrives, all N agents process it concurrently
2. All N produce responses, channel flood
3. Agent responses trigger other agents, cascading loop

## How It Works

All agents receive all messages and process them normally. When an agent finishes, before delivery, Speedtrap checks: have new messages appeared on the channel since this agent started processing?

### Decision Table

| Channel moved? | Write side effects? | Pending follow-ups?  | Outcome                                                            |
| -------------- | ------------------- | -------------------- | ------------------------------------------------------------------ |
| No             | —                   | —                    | **deliver**: response is fresh                                     |
| Yes            | Yes                 | —                    | **reinject**: re-run with write confirmation + buffered follow-ups |
| Yes            | No                  | Yes (coalesce)       | **reinject**: re-run with buffered follow-ups                      |
| Yes            | No                  | No                   | **suppress**: response is stale, discard                           |
| —              | —                   | — (budget exhausted) | **deliver**: fail-safe after max reinjects                         |

### Write Side Effects

If an agent executed write operations (file writes, config changes, API calls) during its run, the side effects already happened. Silently discarding the response means nobody knows what was done. Instead, the agent is re-run with a prompt that includes its draft response and the write tools it invoked, so it can adapt its message to the current conversation while still confirming what it did.

Read-only tool calls (`memory_search`, `web_search`, `file_read`, etc.) are safe to discard.

### Tool Classification

Tools are classified as read or write using:

1. A known list of read-only tools (search, fetch, list, read operations)
2. A prefix heuristic (`read_*`, `search_*`, `get_*`, `list_*`, `find_*`, `fetch_*`, etc.)
3. A configurable default for unknown tools (conservative default: assume write)

### Coalescing (v2)

When `coalesce` is enabled, Speedtrap buffers overlapping inbound messages that arrive while a run is active. This provides richer context on reinjection:

- **inbound_claim**: while a run is active for `(agentId, channelKey)`, overlapping inbound messages are claimed and added to a per-channel pending buffer. This prevents fan-out (other agents picking up the same message).
- **Pending buffer**: bounded ring buffer (`maxBufferedMessages`) with TTL pruning (`pendingTtlMs`). Oldest entries are dropped when the buffer is full; expired entries are pruned before use.
- **Decision enhancement**: when the channel moved and no writes occurred, Speedtrap checks for buffered follow-ups. If present, the agent is reinjected with the follow-up messages so it can produce a consolidated answer.

## What This Solves

- **Thundering herd**: 3 agents process the same message. Fastest delivers. The other 2 are discarded because the channel moved (the first agent's response is now on it).
- **Cascade prevention**: Agent responses trigger other agents, but those runs get discarded too. The cascade burns tokens but produces no output. It self-extinguishes.
- **Convergence**: Structural, not LLM-dependent. No reliance on agents deciding to be quiet.
- **Overlap consolidation** (coalesce): When a user sends follow-up messages while a run is active, those are buffered and folded into the reinjected prompt so the agent answers everything at once.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "speedtrap": {
        "enabled": true,
        "config": {
          "assumeUnknownToolsAreWrites": true,
          "debug": false,
          "coalesce": true,
          "claimWhileActive": true,
          "maxBufferedMessages": 20,
          "pendingTtlMs": 900000,
          "maxReinjects": 3
        }
      }
    }
  }
}
```

| Key                           | Default  | Description                                                                            |
| ----------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `assumeUnknownToolsAreWrites` | `true`   | Unknown tools assumed to have write side effects (forces reinject instead of suppress) |
| `debug`                       | `false`  | Log all decisions to console                                                           |
| `coalesce`                    | `false`  | Enable coalesced stale-response handling with pending buffer                           |
| `claimWhileActive`            | `false`  | Claim overlapping inbounds via `inbound_claim` while a run is active                   |
| `maxBufferedMessages`         | `20`     | Max pending inbound messages per channel (ring buffer)                                 |
| `pendingTtlMs`                | `900000` | TTL for pending buffer entries (15 min)                                                |
| `maxReinjects`                | `3`      | Max reinject attempts before forced delivery                                           |

You can also set these via the CLI:

```sh
openclaw config set plugins.entries.speedtrap.config.coalesce true
openclaw config set plugins.entries.speedtrap.config.claimWhileActive true
openclaw config set plugins.entries.speedtrap.config.debug true
openclaw config set plugins.entries.speedtrap.config.maxReinjects 3
```

## Architecture

```
Inbound message
  |
  +- message_received -> increment channel message counter
  |
  +- inbound_claim -> if active run exists + coalescing: buffer message, claim it
  |
  +- before_agent_start -> snapshot channel counter, mark run active
  |
  +- before_tool_call -> classify tool as read/write, track writes
  |
  +- after_agent_complete -> compare snapshot vs current counter
  |     |
  |     +- unchanged -> deliver
  |     +- moved + writes -> reinject with write confirmation + pending
  |     +- moved + no writes + pending -> reinject with pending
  |     +- moved + no writes + no pending -> suppress
  |     +- budget exhausted -> deliver (fail-safe)
  |
  +- agent_end -> optional telemetry
```

Six hooks. That's the entire plugin.

## Backward Compatibility

When `coalesce=false` (the default), Speedtrap behaves exactly like v1:

- No inbound claiming
- No pending buffer
- Stale no-write responses are always suppressed
- Stale write responses are reinjected without follow-up context

Existing configurations remain valid. New config fields are optional with safe defaults.

## Known Limitations

- **Token cost on cascades**: With `allowBots=true`, agent responses still trigger other agents. Those runs happen (LLM calls, tool calls). Their responses just get discarded. A future `suppressCascade` on `before_dispatch` could prevent these runs entirely, trading memory-building potential for cost savings.
- **Reinject budget is per-run**: After `maxReinjects` attempts, the response is delivered regardless. This prevents infinite loops but means a very active channel could force delivery of a partially stale response.
- **No inter-agent awareness**: Agents don't see each other's responses before delivering. The fastest agent wins; slower agents are discarded.
- **Claim scope**: `inbound_claim` only claims for the specific `(agentId, channelKey)` pair. If multiple agents are active on the same channel, each can only claim for itself.
- **No cross-agent arbitration**: Coalescing operates per agent per channel. There is no global scheduler or centralized turn manager.
