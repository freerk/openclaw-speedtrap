/**
 * Speedtrap Plugin — Discard Stale Responses
 *
 * If the channel moved while an agent was thinking, its response is stale.
 * Drop it, unless the agent executed write operations (reinject instead).
 *
 * Three outcomes:
 *   deliver  — channel unchanged, send response as-is
 *   suppress — channel moved + no writes, discard silently
 *   reinject — channel moved + writes, re-run with context
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
