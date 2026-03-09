/**
 * Speedtrap Coordinator
 *
 * Minimal state manager: tracks per-channel message timestamps and
 * per-agent-run metadata. Three possible outcomes:
 *
 *   deliver  — channel unchanged, response is fresh
 *   suppress — channel moved, no writes, response is stale → discard
 *   reinject — channel moved, has writes → re-run so agent can revise
 *              its response while confirming what it did
 */

import { isWriteTool } from "./classifier.js";
import type { AgentRunState, ChannelState, SpeedtrapDecision, SpeedtrapConfig } from "./types.js";

export class SpeedtrapCoordinator {
  private channels = new Map<string, ChannelState>();
  private agentRuns = new Map<string, AgentRunState>();
  private config: SpeedtrapConfig;
  private log: (msg: string) => void;

  constructor(config: SpeedtrapConfig, log: (msg: string) => void) {
    this.config = config;
    this.log = log;
  }

  // ---------------------------------------------------------------------------
  // message_received: update channel timestamp
  // ---------------------------------------------------------------------------

  onMessageReceived(channelKey: string, timestamp: number): void {
    let channel = this.channels.get(channelKey);
    if (!channel) {
      channel = { channelKey, lastMessageTimestamp: 0 };
      this.channels.set(channelKey, channel);
    }
    channel.lastMessageTimestamp = timestamp;
    this.log(`Channel ${channelKey}: message received, timestamp updated`);
  }

  // ---------------------------------------------------------------------------
  // before_agent_start: snapshot channel timestamp
  // ---------------------------------------------------------------------------

  onAgentStart(agentId: string, channelKey: string): void {
    const channel = this.channels.get(channelKey);
    const snapshotTimestamp = channel?.lastMessageTimestamp ?? 0;

    const runKey = this.runKey(agentId, channelKey);
    this.agentRuns.set(runKey, {
      agentId,
      channelKey,
      startedAt: snapshotTimestamp,
      hasWriteSideEffects: false,
      writeToolNames: [],
    });

    this.log(`Agent ${agentId} started on ${channelKey}, snapshot timestamp=${snapshotTimestamp}`);
  }

  // ---------------------------------------------------------------------------
  // before_tool_call: classify and track writes
  // ---------------------------------------------------------------------------

  onToolCall(agentId: string, channelKey: string, toolName: string): void {
    const runKey = this.runKey(agentId, channelKey);
    const run = this.agentRuns.get(runKey);
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
    const run = this.agentRuns.get(runKey);
    const channel = this.channels.get(channelKey);

    // No tracked run — let it through (conservative)
    if (!run) {
      this.log(`Agent ${agentId} completed on ${channelKey}: no tracked run → delivering`);
      return { action: "deliver" };
    }

    const currentTimestamp = channel?.lastMessageTimestamp ?? 0;
    const channelMoved = currentTimestamp > run.startedAt;

    // Clean up the run state
    this.agentRuns.delete(runKey);

    if (!channelMoved) {
      this.log(`Agent ${agentId} completed on ${channelKey}: channel unchanged → delivering`);
      return { action: "deliver" };
    }

    if (run.hasWriteSideEffects) {
      this.log(
        `Agent ${agentId} completed on ${channelKey}: channel moved, has writes → reinjecting`,
      );
      const context = buildWriteReinjectionPrompt(draftResponse, run.writeToolNames);
      return { action: "reinject", context };
    }

    this.log(`Agent ${agentId} completed on ${channelKey}: channel moved, no writes → discarding`);
    return { action: "suppress" };
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
