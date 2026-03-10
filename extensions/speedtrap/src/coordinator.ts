/**
 * Speedtrap Coordinator — Absorb + Reinject
 *
 * Instead of discarding stale responses, prevents duplicate agent triggers
 * and reinjects buffered messages into the already-running agent.
 *
 * Flow:
 *   1. Message A → agent starts → scope marked as "processing"
 *   2. Message B arrives while processing → buffered
 *   3. Message B's agent trigger → before_agent_start returns suppress
 *   4. Agent finishes A → after_agent_complete sees buffered messages → reinject
 *   5. Agent re-runs with context → no new messages → deliver
 *
 * Scoping:
 *   Keyed by "{agentId}:{physicalChannelKey}" so multi-channel agents
 *   don't interfere across channels.
 *
 * State is module-level (shared singleton) so hooks firing from different
 * subsystems (gateway vs plugins) see the same state.
 */

import { isWriteTool } from "./classifier.js";
import type { SpeedtrapConfig, ScopeState, SpeedtrapDecision } from "./types.js";

// Shared across all coordinator instances
const scopes = new Map<string, ScopeState>();

/** Reset shared state. Exported for tests only. */
export function resetSharedState(): void {
  scopes.clear();
}

/** Build a scope key from agentId + channelKey. */
export function buildScopeKey(agentId: string, channelKey: string): string {
  return `${agentId}:${channelKey}`;
}

export class SpeedtrapCoordinator {
  private readonly config: SpeedtrapConfig;
  private readonly log: (msg: string) => void;

  constructor(config: SpeedtrapConfig, log: (msg: string) => void) {
    this.config = config;
    this.log = log;
  }

  // ---------------------------------------------------------------------------
  // message_received: buffer if scope is processing, otherwise just record
  // ---------------------------------------------------------------------------

  onMessageReceived(channelKey: string, content: string, timestamp: number): void {
    // Check all scopes for this channelKey — buffer if any agent is processing
    for (const [, scope] of scopes) {
      if (scope.channelKey === channelKey && scope.processing) {
        scope.bufferedMessages.push({ content, timestamp });
        this.log(
          `Scope ${scope.scopeKey}: buffered message (${scope.bufferedMessages.length} total)`,
        );
        return;
      }
    }
    this.log(`Channel ${channelKey}: message received, no active scope to buffer`);
  }

  // ---------------------------------------------------------------------------
  // before_agent_start: suppress if scope is already processing
  // ---------------------------------------------------------------------------

  shouldSuppressAgentStart(agentId: string, channelKey: string): boolean {
    const scopeKey = buildScopeKey(agentId, channelKey);
    const existing = scopes.get(scopeKey);

    if (existing?.processing) {
      this.log(`Scope ${scopeKey}: agent already processing → suppress new run`);
      return true;
    }

    // Mark scope as processing
    const scope: ScopeState = existing ?? {
      scopeKey,
      agentId,
      channelKey,
      processing: false,
      bufferedMessages: [],
      writeToolNames: [],
      hasWriteSideEffects: false,
      reinjectCount: 0,
    };
    scope.processing = true;
    scope.writeToolNames = [];
    scope.hasWriteSideEffects = false;
    scopes.set(scopeKey, scope);

    this.log(`Scope ${scopeKey}: agent start, marked as processing`);
    return false;
  }

  // ---------------------------------------------------------------------------
  // before_tool_call: classify and track writes
  // ---------------------------------------------------------------------------

  onToolCall(agentId: string, channelKey: string | undefined, toolName: string): void {
    // Try to find the scope — we may only have agentId
    let scope: ScopeState | undefined;
    if (channelKey) {
      scope = scopes.get(buildScopeKey(agentId, channelKey));
    }
    // Fallback: find any active scope for this agentId
    if (!scope) {
      for (const [, s] of scopes) {
        if (s.agentId === agentId && s.processing) {
          scope = s;
          break;
        }
      }
    }
    if (!scope) return;

    const isWrite = isWriteTool(toolName, this.config.assumeUnknownToolsAreWrites);
    if (isWrite) {
      scope.hasWriteSideEffects = true;
      scope.writeToolNames.push(toolName);
    }
    this.log(
      `Scope ${scope.scopeKey} tool: ${toolName} (${isWrite ? "write" : "read"})`,
    );
  }

  // ---------------------------------------------------------------------------
  // after_agent_complete: deliver / reinject with buffered messages
  // ---------------------------------------------------------------------------

  getDecision(agentId: string, channelKey: string, draftResponse: string): SpeedtrapDecision {
    const scopeKey = buildScopeKey(agentId, channelKey);
    const scope = scopes.get(scopeKey);
    const preview = truncate(draftResponse, 200);

    if (!scope) {
      this.log(`Scope ${scopeKey}: no tracked scope → delivering\n  response: ${preview}`);
      return { action: "deliver" };
    }

    const hasBufferedMessages = scope.bufferedMessages.length > 0;

    if (!hasBufferedMessages) {
      // No new messages arrived — deliver and clean up
      scopes.delete(scopeKey);
      this.log(`Scope ${scopeKey}: no buffered messages → delivering\n  response: ${preview}`);
      return { action: "deliver" };
    }

    // New messages arrived during processing — reinject
    if (scope.reinjectCount >= this.config.maxReinjects) {
      scopes.delete(scopeKey);
      this.log(
        `Scope ${scopeKey}: reinject budget exhausted (${scope.reinjectCount}), delivering\n  response: ${preview}`,
      );
      return { action: "deliver" };
    }

    scope.reinjectCount++;
    const buffered = scope.bufferedMessages.splice(0);
    this.log(
      `Scope ${scopeKey}: ${buffered.length} buffered message(s) → reinjecting (${scope.reinjectCount}/${this.config.maxReinjects})\n  response: ${preview}`,
    );

    const context = buildReinjectionPrompt(
      draftResponse,
      buffered.map((m) => m.content),
      scope.hasWriteSideEffects ? scope.writeToolNames : [],
    );

    // Reset write tracking for the reinject run
    scope.writeToolNames = [];
    scope.hasWriteSideEffects = false;

    return { action: "reinject", context };
  }

  /** Clean up scope when a run ends (for any reason). */
  cleanupScope(agentId: string, channelKey: string): void {
    const scopeKey = buildScopeKey(agentId, channelKey);
    const scope = scopes.get(scopeKey);
    if (scope) {
      scope.processing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Reinjection prompt
// ---------------------------------------------------------------------------

function buildReinjectionPrompt(
  draftResponse: string,
  newMessages: string[],
  writeToolNames: string[],
): string {
  const lines = [
    "[SPEEDTRAP: NEW MESSAGES ARRIVED DURING YOUR RUN]",
    "",
    "While you were processing, the following new messages arrived on the channel:",
  ];

  for (const msg of newMessages) {
    lines.push(`- "${msg}"`);
  }

  lines.push("");

  if (writeToolNames.length > 0) {
    const toolList = [...new Set(writeToolNames)].join(", ");
    lines.push(
      `You executed write operations (${toolList}) — those side effects already happened.`,
      "",
    );
  }

  lines.push(
    "Your drafted response to the original message:",
    draftResponse,
    "",
    "Revise your response to incorporate the new messages.",
    "If the new messages make your response irrelevant, you may respond differently.",
  );
  if (writeToolNames.length > 0) {
    lines.push("You must still confirm the write operations you performed.");
  }
  lines.push("Do not mention this notice in your response.");

  return lines.join("\n");
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replaceAll("\n", " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}
