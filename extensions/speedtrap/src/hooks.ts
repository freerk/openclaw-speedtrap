/**
 * Speedtrap hook bindings.
 *
 * Wires the five lifecycle hooks to the shared coordinator.
 * All hooks build the channel key from channelId + conversationId
 * (available in hook context), skipping accountId.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/speedtrap";
import { buildPhysicalChannelKey } from "./channel-key.js";
import { SpeedtrapCoordinator } from "./coordinator.js";
import { DEFAULT_CONFIG, type SpeedtrapConfig } from "./types.js";

export function registerSpeedtrapHooks(api: OpenClawPluginApi): void {
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

  api.on("message_received", async (_event, ctx) => {
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    coordinator.onMessageReceived(channelKey);
  });

  api.on("before_agent_start", async (_event, ctx) => {
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
