/**
 * Speedtrap Plugin — Discard Stale Responses
 *
 * If the channel moved while an agent was thinking, its response is stale —
 * drop it. If the agent executed write operations, reinject so it can revise
 * its response while confirming what was done.
 *
 * Three outcomes:
 *   deliver  — channel unchanged → send response as-is
 *   suppress — channel moved + no writes → discard silently
 *   reinject — channel moved + writes → re-run with context
 *
 * Hooks used:
 *   message_received     — Update channel timestamp
 *   before_agent_start   — Snapshot channel timestamp at run start
 *   before_tool_call     — Classify tool as read/write, track writes
 *   after_agent_complete  — Compare timestamps → deliver / suppress / reinject
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/speedtrap";
import { SpeedtrapCoordinator } from "./coordinator.js";
import { DEFAULT_CONFIG, type SpeedtrapConfig } from "./types.js";

export default function register(api: OpenClawPluginApi) {
  api.logger.info(`[SPEEDTRAP] register() called, plugin id=${api.id}`);
  const pluginCfg = (api.pluginConfig ?? {}) as Partial<SpeedtrapConfig>;
  const config: SpeedtrapConfig = {
    assumeUnknownToolsAreWrites:
      pluginCfg.assumeUnknownToolsAreWrites ?? DEFAULT_CONFIG.assumeUnknownToolsAreWrites,
    debug: pluginCfg.debug ?? DEFAULT_CONFIG.debug,
    maxReinjects: pluginCfg.maxReinjects ?? DEFAULT_CONFIG.maxReinjects,
  };

  const log = (msg: string) => {
    if (config.debug) {
      api.logger.info(`[SPEEDTRAP] ${msg}`);
    }
  };

  const coordinator = new SpeedtrapCoordinator(config, log);

  // ---------------------------------------------------------------------------
  // message_received: update channel timestamp
  // ---------------------------------------------------------------------------
  api.on("message_received", async (_event, ctx) => {
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    coordinator.onMessageReceived(channelKey, Date.now());
  });

  // ---------------------------------------------------------------------------
  // before_agent_start: record run start time (no channel key needed)
  // ---------------------------------------------------------------------------
  api.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.agentId) return;
    coordinator.onAgentStart(ctx.agentId);
  });

  // ---------------------------------------------------------------------------
  // before_tool_call: classify tool and track write side effects
  // ---------------------------------------------------------------------------
  api.on("before_tool_call", async (event, ctx) => {
    if (!ctx.agentId) return;
    coordinator.onToolCall(ctx.agentId, event.toolName);
  });

  // ---------------------------------------------------------------------------
  // after_agent_complete: deliver / suppress / reinject
  // ---------------------------------------------------------------------------
  api.on("after_agent_complete", async (event, _ctx) => {
    const channelKey = stripAccountFromChannelKey(event.channelKey, event.channelId);
    const decision = coordinator.getDecision(event.agentId, channelKey, event.response);
    if (decision.action === "suppress") {
      return { suppress: true };
    }
    if (decision.action === "reinject") {
      return { reinject: true, injectContext: decision.context };
    }
    // "deliver" → no return = deliver normally
  });
}

// ---------------------------------------------------------------------------
// Channel key normalization
//
// Core builds channelKey as [provider, accountId, to].join(":").
// Multi-agent setups use different accountIds for the same physical channel
// (e.g. "slack:default:channel:C0..." vs "slack:conor:channel:C0...").
// Speedtrap needs to treat these as the same channel, so we strip accountId.
//
// See CHANNEL_KEY_NORMALIZATION.md for the long-term solution (Option B).
// ---------------------------------------------------------------------------

/** Build a physical channel key from message_received components (skip accountId). */
function buildPhysicalChannelKey(channelId: string, conversationId?: string): string {
  return [channelId, conversationId].filter(Boolean).join(":");
}

/**
 * Strip the accountId segment from a core-built channelKey.
 *
 * Core format: "{channelId}:{accountId}:{to}" where channelId = provider name.
 * We strip the first segment after the provider to produce "{channelId}:{to}",
 * matching what buildPhysicalChannelKey produces from message_received.
 *
 * Assumes accountId is a single segment (no colons). This holds for all known
 * providers (Slack, Telegram, WhatsApp, Discord, Teams, Matrix, etc.).
 */
function stripAccountFromChannelKey(channelKey: string, channelId: string): string {
  const prefix = `${channelId}:`;
  if (!channelKey.startsWith(prefix)) return channelKey;
  const afterProvider = channelKey.slice(prefix.length);
  const firstColon = afterProvider.indexOf(":");
  if (firstColon === -1) return channelKey; // no account segment present
  return `${channelId}:${afterProvider.slice(firstColon + 1)}`;
}
