/**
 * Speedtrap Plugin — Absorb + Reinject
 *
 * When a new message arrives while an agent is already processing for the
 * same scope (agent + channel), Speedtrap absorbs the new trigger (prevents
 * a duplicate agent run) and buffers the message content. When the running
 * agent completes, Speedtrap reinjects the buffered messages so the agent
 * can adapt its response to the new context.
 *
 * Two outcomes:
 *   deliver  — no buffered messages, send response as-is
 *   reinject — buffered messages exist, re-run with context
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/speedtrap";
import { registerSpeedtrapHooks } from "./src/hooks.js";

const plugin = {
  id: "speedtrap",
  name: "Speedtrap",
  description: "Absorb duplicate agent triggers and reinject buffered messages",
  register(api: OpenClawPluginApi) {
    api.logger.info(`[SPEEDTRAP] register() called, plugin id=${api.id}`);
    registerSpeedtrapHooks(api);
  },
};

export default plugin;
