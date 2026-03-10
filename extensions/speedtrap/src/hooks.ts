/**
 * Speedtrap hook bindings — Absorb + Reinject
 *
 * Wires four lifecycle hooks to the shared coordinator:
 *   message_received    → buffer if scope is processing
 *   before_agent_start  → suppress if scope is already processing
 *   before_tool_call    → classify and track writes
 *   after_agent_complete → reinject if buffered messages exist
 *
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

  // Buffer incoming messages if an agent is already processing for this scope
  api.on("message_received", async (event, ctx) => {
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    coordinator.onMessageReceived(channelKey, event.content, event.timestamp ?? Date.now());
  });

  // Suppress agent runs when another is already processing for this scope
  api.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.agentId || !ctx.channelId) return;
    const channelKey = buildPhysicalChannelKey(ctx.channelId, ctx.conversationId);
    const shouldSuppress = coordinator.shouldSuppressAgentStart(ctx.agentId, channelKey);
    if (shouldSuppress) {
      return { suppress: true };
    }
  });

  // Track write side effects
  api.on("before_tool_call", async (event, ctx) => {
    if (!ctx.agentId) return;
    const channelKey = ctx.channelId
      ? buildPhysicalChannelKey(ctx.channelId, ctx.conversationId)
      : undefined;
    coordinator.onToolCall(ctx.agentId, channelKey, event.toolName);
  });

  // Reinject if buffered messages exist, otherwise deliver
  api.on("after_agent_complete", async (event, _ctx) => {
    const channelKey = stripAccountFromChannelKey(event.channelKey, event.channelId);
    const decision = coordinator.getDecision(event.agentId, channelKey, event.response);
    if (decision.action === "reinject") {
      return { reinject: true, injectContext: decision.context };
    }
    // "deliver" → return nothing (let core deliver normally)
  });
}
