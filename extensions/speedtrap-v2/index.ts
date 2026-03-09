/**
 * Speedtrap v2 Plugin — Discard Stale Responses
 *
 * If the channel moved while an agent was thinking, its response is stale —
 * drop it. No reinjection. No interruption prompts. No re-runs.
 *
 * The one exception: if the agent executed write operations (file writes,
 * config changes, API calls), deliver anyway — a slightly outdated response
 * that confirms what was done is better than a silent side effect.
 *
 * Hooks used:
 *   message_received     — Update channel timestamp
 *   before_agent_start   — Snapshot channel timestamp at run start
 *   before_tool_call     — Classify tool as read/write, track writes
 *   after_agent_complete  — Compare timestamps → suppress if stale + no writes
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/speedtrap";
import { SpeedtrapV2Coordinator } from "./coordinator.js";
import { DEFAULT_CONFIG, type SpeedtrapV2Config } from "./types.js";

export default function register(api: OpenClawPluginApi) {
  const pluginCfg = (api.pluginConfig ?? {}) as Partial<SpeedtrapV2Config>;
  const config: SpeedtrapV2Config = {
    assumeUnknownToolsAreWrites:
      pluginCfg.assumeUnknownToolsAreWrites ?? DEFAULT_CONFIG.assumeUnknownToolsAreWrites,
    debug: pluginCfg.debug ?? DEFAULT_CONFIG.debug,
  };

  const log = (msg: string) => {
    if (config.debug) {
      api.logger.info(`[SPEEDTRAP] ${msg}`);
    }
  };

  const coordinator = new SpeedtrapV2Coordinator(config, log);

  // ---------------------------------------------------------------------------
  // message_received: update channel timestamp
  // ---------------------------------------------------------------------------
  api.on("message_received", async (_event, ctx) => {
    const channelKey = buildChannelKey(ctx.channelId, ctx.accountId, ctx.conversationId);
    coordinator.onMessageReceived(channelKey, Date.now());
  });

  // ---------------------------------------------------------------------------
  // before_agent_start: snapshot channel timestamp for this run
  // ---------------------------------------------------------------------------
  api.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.channelId || !ctx.agentId) return;
    const channelKey = buildChannelKey(ctx.channelId);
    coordinator.onAgentStart(ctx.agentId, channelKey);
  });

  // ---------------------------------------------------------------------------
  // before_tool_call: classify tool and track write side effects
  // ---------------------------------------------------------------------------
  api.on("before_tool_call", async (event, ctx) => {
    if (!ctx.agentId || !ctx.sessionKey) return;
    const channelKey = deriveChannelKeyFromSession(ctx.sessionKey);
    if (!channelKey) return;
    coordinator.onToolCall(ctx.agentId, channelKey, event.toolName);
  });

  // ---------------------------------------------------------------------------
  // after_agent_complete: discard stale responses, deliver fresh ones
  // ---------------------------------------------------------------------------
  api.on("after_agent_complete", async (event, _ctx) => {
    const suppress = coordinator.shouldSuppress(event.agentId, event.channelKey);
    if (suppress) {
      return { suppress: true };
    }
    // No return = deliver normally
  });
}

// ---------------------------------------------------------------------------
// Helpers (reused from v1)
// ---------------------------------------------------------------------------

function buildChannelKey(
  channelId: string,
  accountId?: string,
  conversationId?: string,
): string {
  return [channelId, accountId, conversationId].filter(Boolean).join(":");
}

/**
 * Derive a channel key from a session key. Best-effort heuristic.
 * Session keys follow: agent:<agentId>:<channel>:<...identifiers>
 */
function deriveChannelKeyFromSession(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":");
  if (parts.length < 3) return undefined;
  const channelStart = parts[0] === "agent" ? 2 : 0;
  if (channelStart >= parts.length) return undefined;
  const channelParts = parts.slice(channelStart, Math.min(channelStart + 3, parts.length));
  return channelParts.join(":");
}
