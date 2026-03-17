/**
 * Speedtrap Coordinator
 *
 * Minimal state manager: tracks per-channel message counters and
 * per-agent-run metadata. Four possible outcomes:
 *
 *   deliver  — channel unchanged, response is fresh
 *   suppress — channel moved, no writes, no pending follow-ups → discard
 *   reinject — channel moved + writes, or channel moved + pending follow-ups
 *              → re-run so agent can revise its response
 *   deliver  — budget exhausted after reinject attempts → fail-safe
 *
 * v2 adds coalescing:
 *   - inbound_claim: while a run is active for (agentId, channelKey),
 *     overlapping inbound messages are claimed and buffered.
 *   - Pending buffer is bounded (maxBufferedMessages) with TTL pruning.
 *   - Decision rules use pending buffer to decide reinject vs suppress
 *     when the channel moved but no writes occurred.
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
import type {
  AgentRunState,
  ChannelState,
  PendingInbound,
  SpeedtrapConfig,
  SpeedtrapDecision,
} from "./types.js";

type SpeedtrapGlobalState = {
  channels: Map<string, ChannelState>;
  agentRuns: Map<string, AgentRunState>;
};

const GLOBAL_STATE_KEY = Symbol.for("openclaw.speedtrap.shared-state");

function getGlobalState(): SpeedtrapGlobalState {
  const store = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: SpeedtrapGlobalState;
  };
  return (store[GLOBAL_STATE_KEY] ??= {
    channels: new Map(),
    agentRuns: new Map(),
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
    const channel = this.ensureChannel(channelKey);
    channel.messageCount++;
    this.log(`Channel ${channelKey}: message received, count=${channel.messageCount}`);
  }

  // ---------------------------------------------------------------------------
  // inbound_claim: claim overlapping inbound while a run is active
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the message was claimed (buffered), false if not claimed.
   * Only claims when coalescing + claimWhileActive are enabled and ANY active
   * run exists on this channel. The inbound_claim hook fires before agent
   * selection, so there is no agentId available.
   */
  onInboundClaim(channelKey: string, message: PendingInbound): boolean {
    if (!this.config.coalesce || !this.config.claimWhileActive) {
      return false;
    }

    // Check if any active run exists on this channel.
    const hasActiveRun = this.hasActiveRunOnChannel(channelKey);
    if (!hasActiveRun) {
      return false;
    }

    const channel = this.ensureChannel(channelKey);
    this.pruneExpiredPending(channel);

    // Ring buffer: drop oldest if at capacity
    if (channel.pending.length >= this.config.maxBufferedMessages) {
      channel.pending.shift();
    }

    channel.pending.push({
      ...message,
      ts: message.ts ?? Date.now(),
    });

    this.log(`Claimed inbound on ${channelKey}, buffer size=${channel.pending.length}`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // before_agent_start: snapshot channel message count
  // ---------------------------------------------------------------------------

  onAgentStart(agentId: string, channelKey: string): void {
    const channel = this.ensureChannel(channelKey);
    const snapshotMessageCount = channel.messageCount;

    const runKey = this.runKey(agentId, channelKey);
    agentRuns.set(runKey, {
      agentId,
      channelKey,
      snapshotMessageCount,
      hasWriteSideEffects: false,
      writeToolNames: [],
      reinjectCount: 0,
      active: true,
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

    // A) Channel unchanged → deliver
    if (!channelMoved) {
      this.cleanupRun(runKey, channelKey);
      this.log(
        `Agent ${agentId} completed on ${channelKey}: channel unchanged → delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    // D) Budget exhausted → deliver (fail-safe)
    if (run.reinjectCount >= this.config.maxReinjects) {
      this.cleanupRun(runKey, channelKey);
      this.log(
        `Agent ${agentId} on ${channelKey}: reinject budget exhausted (${run.reinjectCount}), delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    // Prune expired pending entries before checking
    if (channel && this.config.coalesce) {
      this.pruneExpiredPending(channel);
    }

    // Snapshot and consume pending buffer: the first agent to reinject
    // gets the buffered messages, subsequent agents see an empty buffer.
    const pendingMessages = channel?.pending ? [...channel.pending] : [];
    if (channel && pendingMessages.length > 0) {
      channel.pending = [];
    }

    // B) Channel moved + writes → reinject (mandatory)
    if (run.hasWriteSideEffects) {
      run.reinjectCount++;
      this.log(
        `Agent ${agentId} on ${channelKey}: channel moved, has writes → reinjecting (${run.reinjectCount}/${this.config.maxReinjects})\n  response: ${preview}`,
      );
      const context = this.config.coalesce
        ? buildCoalescedReinjectionPrompt(draftResponse, run.writeToolNames, pendingMessages)
        : buildWriteReinjectionPrompt(draftResponse, run.writeToolNames);
      return { action: "reinject", context };
    }

    // C) Channel moved + no writes
    if (this.config.coalesce && pendingMessages.length > 0) {
      // Has buffered follow-ups → reinject
      run.reinjectCount++;
      this.log(
        `Agent ${agentId} on ${channelKey}: channel moved, no writes, ${pendingMessages.length} pending → reinjecting (${run.reinjectCount}/${this.config.maxReinjects})\n  response: ${preview}`,
      );
      const context = buildCoalescedReinjectionPrompt(draftResponse, [], pendingMessages);
      return { action: "reinject", context };
    }

    // No writes + no pending (or coalesce disabled) → suppress
    this.cleanupRun(runKey, channelKey);
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

  private hasActiveRunOnChannel(channelKey: string): boolean {
    for (const run of agentRuns.values()) {
      if (run.channelKey === channelKey && run.active) {
        return true;
      }
    }
    return false;
  }

  private ensureChannel(channelKey: string): ChannelState {
    let channel = channels.get(channelKey);
    if (!channel) {
      channel = { channelKey, messageCount: 0, pending: [] };
      channels.set(channelKey, channel);
    }
    return channel;
  }

  private cleanupRun(runKey: string, channelKey: string): void {
    agentRuns.delete(runKey);
    // Clear pending buffer on terminal decision
    const channel = channels.get(channelKey);
    if (channel) {
      channel.pending = [];
    }
  }

  private pruneExpiredPending(channel: ChannelState): void {
    const cutoff = Date.now() - this.config.pendingTtlMs;
    channel.pending = channel.pending.filter((p) => (p.ts ?? 0) >= cutoff);
  }
}

// ---------------------------------------------------------------------------
// Reinjection prompt for write-side-effect runs (v1 compat, coalesce=false)
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

// ---------------------------------------------------------------------------
// Coalesced reinjection prompt (v2, coalesce=true)
// ---------------------------------------------------------------------------

function buildCoalescedReinjectionPrompt(
  draftResponse: string,
  writeToolNames: string[],
  pendingMessages: PendingInbound[],
): string {
  const lines: string[] = [
    "[SPEEDTRAP: CHANNEL MOVED DURING YOUR RUN]",
    "",
    "New messages appeared on the channel while you were working.",
  ];

  if (pendingMessages.length > 0) {
    lines.push("");
    lines.push("Buffered follow-up messages (oldest to newest):");
    for (const msg of pendingMessages) {
      const prefix = msg.sender ? `[${msg.sender}] ` : "";
      lines.push(`  - ${prefix}${msg.content}`);
    }
  }

  if (writeToolNames.length > 0) {
    const toolList = [...new Set(writeToolNames)].join(", ");
    lines.push("");
    lines.push(
      `You executed write operations (${toolList}) — those side effects already happened.`,
    );
  }

  lines.push("");
  lines.push("Your drafted response:");
  lines.push(draftResponse);
  lines.push("");
  lines.push("Revise your response to account for the new channel activity.");
  if (writeToolNames.length > 0) {
    lines.push("You must still confirm what you did (the writes already happened),");
    lines.push("but adapt your message to the current conversation state.");
  }
  lines.push("Do not mention this notice in your response.");

  return lines.join("\n");
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replaceAll("\n", " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}
