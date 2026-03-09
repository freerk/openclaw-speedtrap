/**
 * Speedtrap hook bindings.
 *
 * Wires the four lifecycle hooks to the shared coordinator.
 * Separated from index.ts so the plugin entry point stays minimal.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/speedtrap";
import { buildPhysicalChannelKey, stripAccountFromChannelKey } from "./channel-key.js";
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
    coordinator.onMessageReceived(channelKey, Date.now());
  });

  api.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.agentId) return;
    coordinator.onAgentStart(ctx.agentId);
  });

  api.on("before_tool_call", async (event, ctx) => {
    if (!ctx.agentId) return;
    coordinator.onToolCall(ctx.agentId, event.toolName);
  });

  api.on("after_agent_complete", async (event, _ctx) => {
    const channelKey = stripAccountFromChannelKey(event.channelKey, event.channelId);
    const decision = coordinator.getDecision(event.agentId, channelKey, event.response);
    if (decision.action === "suppress") {
      return { suppress: true };
    }
    if (decision.action === "reinject") {
      return { reinject: true, injectContext: decision.context };
    }
  });
}
