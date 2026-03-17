/**
 * Speedtrap Plugin — Coalesced Stale-Response Handling
 *
 * If the channel moved while an agent was thinking, its response is stale.
 * With coalescing, overlapping messages are buffered per-agent and folded
 * into the reinject context.
 *
 * Four outcomes:
 *   deliver  — channel unchanged, or reinject budget exhausted
 *   suppress — channel moved, no writes, no pending
 *   reinject — channel moved + writes, or channel moved + pending
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/speedtrap";
import { registerSpeedtrapHooks } from "./src/hooks.js";

const plugin = {
  id: "speedtrap",
  name: "Speedtrap",
  description: "Discard stale agent responses when a channel moved during processing",
  register(api: OpenClawPluginApi) {
    api.logger.info(`[SPEEDTRAP] register() called, plugin id=${api.id}`);
    registerSpeedtrapHooks(api);
  },
};

export default plugin;
