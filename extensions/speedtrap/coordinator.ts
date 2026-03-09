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
 *
 * Keying strategy:
 *   - Channel state keyed by the full channelKey from message_received
 *     (e.g. "slack:default:channel:C0AJD0XBMUJ").
 *   - Agent runs keyed by agentId only. An agent has at most one active
 *     run, and this avoids channelKey format mismatches between hooks
 *     that have different context available.
 *   - getDecision receives the authoritative channelKey from core's
 *     after_agent_complete event, which matches message_received's format.
 *   - Both message_received and onAgentStart use Date.now(), so the
 *     "channel moved" comparison is wall-clock based.
 */

import { isWriteTool } from "./classifier.js";
import type { AgentRunState, ChannelState, SpeedtrapDecision, SpeedtrapConfig } from "./types.js";

export class SpeedtrapCoordinator {
  private readonly channels = new Map<string, ChannelState>();
  private readonly agentRuns = new Map<string, AgentRunState>();
  private readonly config: SpeedtrapConfig;
  private readonly log: (msg: string) => void;

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
  // before_agent_start: record run start time
  // ---------------------------------------------------------------------------

  onAgentStart(agentId: string): void {
    const startedAt = Date.now();
    this.agentRuns.set(agentId, {
      agentId,
      startedAt,
      hasWriteSideEffects: false,
      writeToolNames: [],
      reinjectCount: 0,
    });

    this.log(`Agent ${agentId} started, timestamp=${startedAt}`);
  }

  // ---------------------------------------------------------------------------
  // before_tool_call: classify and track writes
  // ---------------------------------------------------------------------------

  onToolCall(agentId: string, toolName: string): void {
    const run = this.agentRuns.get(agentId);
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
    const run = this.agentRuns.get(agentId);
    const channel = this.channels.get(channelKey);

    const preview = truncate(draftResponse, 200);

    // No tracked run — let it through (conservative)
    if (!run) {
      this.log(
        `Agent ${agentId} completed on ${channelKey}: no tracked run → delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    const currentTimestamp = channel?.lastMessageTimestamp ?? 0;
    const channelMoved = currentTimestamp > run.startedAt;

    if (!channelMoved) {
      this.agentRuns.delete(agentId);
      this.log(
        `Agent ${agentId} completed on ${channelKey}: channel unchanged → delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    if (run.hasWriteSideEffects) {
      if (run.reinjectCount >= this.config.maxReinjects) {
        this.agentRuns.delete(agentId);
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

    this.agentRuns.delete(agentId);
    this.log(
      `Agent ${agentId} completed on ${channelKey}: channel moved, no writes → discarding\n  response: ${preview}`,
    );
    return { action: "suppress" };
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
