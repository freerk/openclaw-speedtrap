/**
 * Speedtrap v2 Coordinator
 *
 * Minimal state manager: tracks per-channel message timestamps and
 * per-agent-run metadata. The only decision is discard vs deliver.
 *
 * No buffering. No reinjection. No turn management.
 */

import { isWriteTool } from "./classifier.js";
import type { AgentRunState, ChannelState, SpeedtrapV2Config } from "./types.js";

export class SpeedtrapV2Coordinator {
  private channels = new Map<string, ChannelState>();
  private agentRuns = new Map<string, AgentRunState>();
  private config: SpeedtrapV2Config;
  private log: (msg: string) => void;

  constructor(config: SpeedtrapV2Config, log: (msg: string) => void) {
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
    }
    this.log(`Agent ${agentId} tool call: ${toolName} (classified as ${isWrite ? "write" : "read"})`);
  }

  // ---------------------------------------------------------------------------
  // after_agent_complete: discard or deliver
  // ---------------------------------------------------------------------------

  shouldSuppress(agentId: string, channelKey: string): boolean {
    const runKey = this.runKey(agentId, channelKey);
    const run = this.agentRuns.get(runKey);
    const channel = this.channels.get(channelKey);

    // No tracked run — let it through (conservative)
    if (!run) {
      this.log(`Agent ${agentId} completed on ${channelKey}: no tracked run → delivering`);
      return false;
    }

    const currentTimestamp = channel?.lastMessageTimestamp ?? 0;
    const channelMoved = currentTimestamp > run.startedAt;

    // Clean up the run state
    this.agentRuns.delete(runKey);

    if (!channelMoved) {
      this.log(`Agent ${agentId} completed on ${channelKey}: channel unchanged → delivering`);
      return false;
    }

    if (run.hasWriteSideEffects) {
      this.log(
        `Agent ${agentId} completed on ${channelKey}: channel moved, has writes → delivering (forced)`,
      );
      return false;
    }

    this.log(`Agent ${agentId} completed on ${channelKey}: channel moved, no writes → discarding`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private runKey(agentId: string, channelKey: string): string {
    return `${agentId}::${channelKey}`;
  }
}
