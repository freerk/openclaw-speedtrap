/**
 * Speedtrap hook bindings.
 *
 * Wires the six lifecycle hooks to the shared coordinator.
 * All hooks build the channel key from channelId + conversationId
 * (available in hook context), skipping accountId.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/speedtrap";
import { buildPhysicalChannelKey } from "./channel-key.js";
import { SpeedtrapCoordinator } from "./coordinator.js";
import { DEFAULT_CONFIG, type SpeedtrapConfig } from "./types.js";

export function registerSpeedtrapHooks(api: OpenClawPluginApi): void {
  // No registration guard: each loadOpenClawPlugins() call creates a new
  // plugin registry and may replace the global hook runner via
  // activatePluginRegistry(). Hooks must be present in every registry so
  // whichever one becomes the active runner has them. Duplicate handlers
  // across registries are not a problem because the runner only uses one
  // registry at a time. All coordinator instances share state via globalThis
  // (see coordinator.ts).

  const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const config: SpeedtrapConfig = {
    assumeUnknownToolsAreWrites:
      typeof pluginCfg.assumeUnknownToolsAreWrites === "boolean"
        ? pluginCfg.assumeUnknownToolsAreWrites
        : DEFAULT_CONFIG.assumeUnknownToolsAreWrites,
    debug: typeof pluginCfg.debug === "boolean" ? pluginCfg.debug : DEFAULT_CONFIG.debug,
    maxReinjects:
      typeof pluginCfg.maxReinjects === "number"
        ? pluginCfg.maxReinjects
        : DEFAULT_CONFIG.maxReinjects,
    coalesce:
      typeof pluginCfg.coalesce === "boolean" ? pluginCfg.coalesce : DEFAULT_CONFIG.coalesce,
    claimWhileActive:
      typeof pluginCfg.claimWhileActive === "boolean"
        ? pluginCfg.claimWhileActive
        : DEFAULT_CONFIG.claimWhileActive,
    maxBufferedMessages:
      typeof pluginCfg.maxBufferedMessages === "number"
        ? pluginCfg.maxBufferedMessages
        : DEFAULT_CONFIG.maxBufferedMessages,
    pendingTtlMs:
      typeof pluginCfg.pendingTtlMs === "number"
        ? pluginCfg.pendingTtlMs
        : DEFAULT_CONFIG.pendingTtlMs,
  };

  const log = (msg: string) => {
    if (config.debug) {
      api.logger.info(`[SPEEDTRAP] ${msg}`);
    }
  };

  const coordinator = new SpeedtrapCoordinator(config, log);

  api.on("message_received", async (_event, ctx) => {
    log(
      `message_received ctx: channelId=${ctx.channelId} accountId=${ctx.accountId} conversationId=${ctx.conversationId}`,
    );
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    coordinator.onMessageReceived(channelKey);
  });

  api.on("inbound_claim", async (event, ctx) => {
    log(
      `inbound_claim ctx: channelId=${ctx.channelId} accountId=${ctx.accountId} conversationId=${ctx.conversationId}`,
    );
    if (!ctx.channelId) return;
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    const claimed = coordinator.onInboundClaim(channelKey, {
      content: event.content ?? "",
      sender: event.senderName ?? event.senderId,
      messageId: event.messageId,
      ts: event.timestamp,
    });
    if (claimed) {
      return { handled: true };
    }
  });

  api.on("before_agent_start", async (_event, ctx) => {
    log(
      `before_agent_start ctx: agentId=${ctx.agentId} channelId=${ctx.channelId} conversationId=${ctx.conversationId}`,
    );
    if (!ctx.agentId || !ctx.channelId) return;
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    coordinator.onAgentStart(ctx.agentId, channelKey);
  });

  api.on("before_tool_call", async (event, ctx) => {
    if (!ctx.agentId || !ctx.channelId) return;
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    coordinator.onToolCall(ctx.agentId, channelKey, event.toolName);
  });

  api.on("after_agent_complete", async (event, ctx) => {
    const channelKey = buildPhysicalChannelKey(
      event.channelId,
      event.conversationId ?? ctx.conversationId,
    );
    const decision = coordinator.getDecision(event.agentId, channelKey, event.response);
    if (decision.action === "suppress") {
      return { suppress: true };
    }
    if (decision.action === "reinject") {
      return { reinject: true, injectContext: decision.context };
    }
  });

  api.on("agent_end", async (event, ctx) => {
    if (!ctx.agentId || !ctx.channelId) return;
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    coordinator.onAgentEnd(ctx.agentId, channelKey, event);
  });
}
