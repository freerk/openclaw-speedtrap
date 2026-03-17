/**
 * Speedtrap Coordinator
 *
 * Minimal state manager: tracks per-channel message counters and
 * per-agent-run metadata. Three possible outcomes:
 *
 *   deliver  — channel unchanged, response is fresh
 *   suppress — channel moved, no writes, response is stale → discard
 *   reinject — channel moved, has writes → re-run so agent can revise
 *              its response while confirming what it did
 *
 * Keying strategy:
 *   - Channel state keyed by the normalized physical channelKey
 *     (e.g. "slack:channel:C0AJD0XBMUJ"), built from channelId +
 *     conversationId (skipping accountId so multi-agent setups on
 *     different bot accounts see the same physical channel).
 *   - Agent runs keyed by agentId::channelKey (an agent processes
 *     one channel at a time, but we need channel scope for the
 *     message counter comparison).
 *   - Staleness detection uses a monotonic message counter per channel,
 *     not wall-clock timestamps. This avoids races where the agent's
 *     own triggering message could register as "channel moved".
 *
 * State lives on globalThis via Symbol.for():
 *   The plugin is loaded through jiti, which creates a fresh module
 *   instance per loadOpenClawPlugins() call (each call builds a new
 *   jiti loader). Module-level variables would be separate per instance,
 *   breaking cross-subsystem state sharing. Using globalThis with a
 *   well-known Symbol key ensures all instances in the same process
 *   share the same Maps, regardless of how many times the module is
 *   imported.
 */

import { isWriteTool } from "./classifier.js";
import type { AgentRunState, ChannelState, SpeedtrapDecision, SpeedtrapConfig } from "./types.js";

type SpeedtrapGlobalState = {
  channels: Map<string, ChannelState>;
  agentRuns: Map<string, AgentRunState>;
  hooksRegistered: boolean;
};

const GLOBAL_STATE_KEY = Symbol.for("openclaw.speedtrap.shared-state");

export function getGlobalState(): SpeedtrapGlobalState {
  const store = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: SpeedtrapGlobalState;
  };
  return (store[GLOBAL_STATE_KEY] ??= {
    channels: new Map(),
    agentRuns: new Map(),
    hooksRegistered: false,
  });
}

// Shared across all coordinator instances so hooks firing from different
// subsystems (gateway vs plugins) see the same state.
const { channels, agentRuns } = getGlobalState();

/** Reset shared state. Exported for tests only. */
export function resetSharedState(): void {
  const state = getGlobalState();
  state.channels.clear();
  state.agentRuns.clear();
  state.hooksRegistered = false;
}

export class SpeedtrapCoordinator {
  private readonly config: SpeedtrapConfig;
  private readonly log: (msg: string) => void;

  constructor(config: SpeedtrapConfig, log: (msg: string) => void) {
    this.config = config;
    this.log = log;
  }

  // ---------------------------------------------------------------------------
  // message_received: increment channel message counter
  // ---------------------------------------------------------------------------

  onMessageReceived(channelKey: string): void {
    let channel = channels.get(channelKey);
    if (!channel) {
      channel = { channelKey, messageCount: 0 };
      channels.set(channelKey, channel);
    }
    channel.messageCount++;
    this.log(`Channel ${channelKey}: message received, count=${channel.messageCount}`);
  }

  // ---------------------------------------------------------------------------
  // before_agent_start: snapshot channel message count
  // ---------------------------------------------------------------------------

  onAgentStart(agentId: string, channelKey: string): void {
    const channel = channels.get(channelKey);
    const snapshotMessageCount = channel?.messageCount ?? 0;

    const runKey = this.runKey(agentId, channelKey);
    agentRuns.set(runKey, {
      agentId,
      channelKey,
      snapshotMessageCount,
      hasWriteSideEffects: false,
      writeToolNames: [],
      reinjectCount: 0,
    });

    this.log(`Agent ${agentId} started on ${channelKey}, snapshot count=${snapshotMessageCount}`);
  }

  // ---------------------------------------------------------------------------
  // before_tool_call: classify and track writes
  // ---------------------------------------------------------------------------

  onToolCall(agentId: string, channelKey: string, toolName: string): void {
    const runKey = this.runKey(agentId, channelKey);
    const run = agentRuns.get(runKey);
    if (!run) return;

    const isWrite = isWriteTool(toolName, this.config.assumeUnknownToolsAreWrites);
    if (isWrite) {
      run.hasWriteSideEffects = true;
      run.writeToolNames.push(toolName);
    }
    this.log(
      `Agent ${agentId} tool call: ${toolName} (classified as ${isWrite ? "write" : "read"})`,
    );
  }

  // ---------------------------------------------------------------------------
  // after_agent_complete: deliver / suppress / reinject
  // ---------------------------------------------------------------------------

  getDecision(agentId: string, channelKey: string, draftResponse: string): SpeedtrapDecision {
    const runKey = this.runKey(agentId, channelKey);
    const run = agentRuns.get(runKey);
    const channel = channels.get(channelKey);

    const preview = truncate(draftResponse, 200);

    // No tracked run — let it through (conservative)
    if (!run) {
      this.log(
        `Agent ${agentId} completed on ${channelKey}: no tracked run → delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    const currentCount = channel?.messageCount ?? 0;
    const channelMoved = currentCount > run.snapshotMessageCount;

    if (!channelMoved) {
      agentRuns.delete(runKey);
      this.log(
        `Agent ${agentId} completed on ${channelKey}: channel unchanged → delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    if (run.hasWriteSideEffects) {
      if (run.reinjectCount >= this.config.maxReinjects) {
        agentRuns.delete(runKey);
        this.log(
          `Agent ${agentId} on ${channelKey}: reinject budget exhausted (${run.reinjectCount}), delivering\n  response: ${preview}`,
        );
        return { action: "deliver" };
      }
      // Keep the run state — we'll see it again after core re-runs the agent
      run.reinjectCount++;
      this.log(
        `Agent ${agentId} on ${channelKey}: channel moved, has writes → reinjecting (${run.reinjectCount}/${this.config.maxReinjects})\n  response: ${preview}`,
      );
      const context = buildWriteReinjectionPrompt(draftResponse, run.writeToolNames);
      return { action: "reinject", context };
    }

    agentRuns.delete(runKey);
    this.log(
      `Agent ${agentId} completed on ${channelKey}: channel moved, no writes → discarding\n  response: ${preview}`,
    );
    return { action: "suppress" };
  }

  // ---------------------------------------------------------------------------
  // agent_end: log when an agent run produced no response
  // ---------------------------------------------------------------------------

  onAgentEnd(
    agentId: string,
    channelKey: string,
    event: { messages: unknown[]; success: boolean; durationMs?: number },
  ): void {
    const hasAssistantReply = event.messages.some(
      (m) =>
        typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "assistant",
    );
    if (!hasAssistantReply) {
      this.log(
        `Agent ${agentId} ended on ${channelKey} with no response (success=${event.success}, duration=${event.durationMs ?? "?"}ms)`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private runKey(agentId: string, channelKey: string): string {
    return `${agentId}::${channelKey}`;
  }
}

// ---------------------------------------------------------------------------
// Reinjection prompt for write-side-effect runs
// ---------------------------------------------------------------------------

function buildWriteReinjectionPrompt(draftResponse: string, writeToolNames: string[]): string {
  const toolList = [...new Set(writeToolNames)].join(", ");
  return [
    "[SPEEDTRAP: CHANNEL MOVED DURING YOUR RUN]",
    "",
    "New messages appeared on the channel while you were working.",
    `You executed write operations (${toolList}) — those side effects already happened.`,
    "",
    "Your drafted response:",
    draftResponse,
    "",
    "Revise your response to account for the new channel activity.",
    "You must still confirm what you did (the writes already happened),",
    "but adapt your message to the current conversation state.",
    "Do not mention this notice in your response.",
  ].join("\n");
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replaceAll("\n", " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}
