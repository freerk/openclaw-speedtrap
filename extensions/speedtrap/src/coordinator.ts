/**
 * Speedtrap Coordinator
 *
 * Per-agent-run state manager. Four possible outcomes:
 *
 *   deliver  — channel unchanged, response is fresh
 *   suppress — channel moved, no writes, no pending
 *   reinject — channel moved + writes, or channel moved + pending
 *   deliver  — budget exhausted after reinject attempts (fail-safe)
 *
 * "Channel moved" is a boolean flag per run, not a counter comparison.
 * When any message arrives on a channel (message_received), all active
 * runs on that channel are marked dirty. The decision logic checks the
 * flag, not a counter delta.
 *
 * Pending buffers are per-agent-run:
 *   When a message is claimed, it is appended to every active run on
 *   that channel. Each agent accumulates its own view of what happened
 *   while it was thinking. When an agent gets reinjected, its buffer
 *   is consumed (cleared). Other agents keep their own buffers intact.
 *
 * State lives on globalThis via Symbol.for():
 *   The plugin is loaded through jiti, which creates a fresh module
 *   instance per loadOpenClawPlugins() call. Module-level variables
 *   would be separate per instance. Using globalThis with a well-known
 *   Symbol key ensures all instances share the same Map.
 */

import { isWriteTool } from "./classifier.js";
import type { AgentRunState, PendingInbound, SpeedtrapConfig, SpeedtrapDecision } from "./types.js";

type SpeedtrapGlobalState = {
  agentRuns: Map<string, AgentRunState>;
};

const GLOBAL_STATE_KEY = Symbol.for("openclaw.speedtrap.shared-state");

function getGlobalState(): SpeedtrapGlobalState {
  const store = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: SpeedtrapGlobalState;
  };
  return (store[GLOBAL_STATE_KEY] ??= {
    agentRuns: new Map(),
  });
}

const { agentRuns } = getGlobalState();

/** Reset shared state. Exported for tests only. */
export function resetSharedState(): void {
  const state = getGlobalState();
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
  // message_received: mark all active runs on this channel as dirty
  // ---------------------------------------------------------------------------

  onMessageReceived(channelKey: string): void {
    let marked = 0;
    for (const run of agentRuns.values()) {
      if (run.channelKey === channelKey && run.active) {
        run.channelDirty = true;
        marked++;
      }
    }
    this.log(`Channel ${channelKey}: message received, marked ${marked} active run(s) dirty`);
  }

  // ---------------------------------------------------------------------------
  // inbound_claim: buffer into ALL active runs on this channel
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the message was claimed (buffered), false if not claimed.
   * When claimed, the message is appended to every active run on the channel
   * so each agent gets its own view of what happened while it was processing.
   */
  onInboundClaim(channelKey: string, message: PendingInbound): boolean {
    if (!this.config.coalesce || !this.config.claimWhileActive) {
      this.log(
        `Claim skip on ${channelKey}: coalesce=${this.config.coalesce} claimWhileActive=${this.config.claimWhileActive}`,
      );
      return false;
    }

    const activeRuns = this.getActiveRunsOnChannel(channelKey);
    if (activeRuns.length === 0) {
      this.log(`Claim skip on ${channelKey}: no active runs`);
      return false;
    }

    const entry: PendingInbound = {
      ...message,
      ts: message.ts ?? Date.now(),
    };

    for (const run of activeRuns) {
      this.pruneExpiredPending(run);
      if (run.pending.length >= this.config.maxBufferedMessages) {
        run.pending.shift();
      }
      run.pending.push(entry);
    }

    this.log(`Claimed inbound on ${channelKey}, distributed to ${activeRuns.length} active run(s)`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // before_agent_start: create run state
  // ---------------------------------------------------------------------------

  onAgentStart(agentId: string, channelKey: string): void {
    const runKey = this.runKey(agentId, channelKey);
    agentRuns.set(runKey, {
      agentId,
      channelKey,
      channelDirty: false,
      hasWriteSideEffects: false,
      writeToolNames: [],
      reinjectCount: 0,
      active: true,
      pending: [],
    });

    this.log(`Agent ${agentId} started on ${channelKey}`);
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

    const preview = truncate(draftResponse, 200);

    // No tracked run: let it through (conservative)
    if (!run) {
      this.log(
        `Agent ${agentId} completed on ${channelKey}: no tracked run, delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    // A) Channel unchanged: deliver
    if (!run.channelDirty) {
      agentRuns.delete(runKey);
      this.log(
        `Agent ${agentId} completed on ${channelKey}: channel unchanged, delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    // D) Budget exhausted: deliver (fail-safe)
    if (run.reinjectCount >= this.config.maxReinjects) {
      agentRuns.delete(runKey);
      this.log(
        `Agent ${agentId} on ${channelKey}: reinject budget exhausted (${run.reinjectCount}), delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    // Prune expired pending entries before checking
    if (this.config.coalesce) {
      this.pruneExpiredPending(run);
    }

    // Snapshot and consume this agent's pending buffer
    const pendingMessages = run.pending.length > 0 ? [...run.pending] : [];
    run.pending = [];

    // Reset dirty flag: the agent is about to re-run with current context.
    // If new messages arrive during the re-run, the flag will be set again.
    run.channelDirty = false;

    // B) Channel moved + writes: reinject (mandatory)
    if (run.hasWriteSideEffects) {
      run.reinjectCount++;
      this.log(
        `Agent ${agentId} on ${channelKey}: channel moved, has writes, reinjecting (${run.reinjectCount}/${this.config.maxReinjects})\n  response: ${preview}`,
      );
      const context = this.config.coalesce
        ? buildCoalescedReinjectionPrompt(draftResponse, run.writeToolNames, pendingMessages)
        : buildWriteReinjectionPrompt(draftResponse, run.writeToolNames);
      return { action: "reinject", context };
    }

    // C) Channel moved + no writes + has pending: reinject with context
    if (this.config.coalesce && pendingMessages.length > 0) {
      run.reinjectCount++;
      this.log(
        `Agent ${agentId} on ${channelKey}: channel moved, no writes, ${pendingMessages.length} pending, reinjecting (${run.reinjectCount}/${this.config.maxReinjects})\n  response: ${preview}`,
      );
      const context = buildCoalescedReinjectionPrompt(draftResponse, [], pendingMessages);
      return { action: "reinject", context };
    }

    // E) Channel moved + no writes + no pending: suppress
    agentRuns.delete(runKey);
    this.log(
      `Agent ${agentId} completed on ${channelKey}: channel moved, no writes, suppressing\n  response: ${preview}`,
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

  private getActiveRunsOnChannel(channelKey: string): AgentRunState[] {
    const active: AgentRunState[] = [];
    for (const run of agentRuns.values()) {
      if (run.channelKey === channelKey && run.active) {
        active.push(run);
      }
    }
    return active;
  }

  private pruneExpiredPending(run: AgentRunState): void {
    const cutoff = Date.now() - this.config.pendingTtlMs;
    run.pending = run.pending.filter((p) => (p.ts ?? 0) >= cutoff);
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
