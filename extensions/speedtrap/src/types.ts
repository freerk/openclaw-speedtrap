/**
 * Speedtrap — Types
 *
 * Per-agent-run state model with dirty flag and pending buffer.
 * Coalescing (v2): overlapping inbound messages are claimed and buffered
 * per-agent, enabling reinject with full context.
 */

export interface SpeedtrapConfig {
  /**
   * When true (default), unknown tools are assumed to have write side effects.
   * This is the conservative default — unknown tools force delivery even if
   * the channel moved, which is safer than silently discarding responses
   * that had side effects.
   */
  assumeUnknownToolsAreWrites: boolean;
  /** Log all Speedtrap decisions to console. */
  debug: boolean;
  /** Max reinject attempts before forcing delivery. Plugin-owned budget. */
  maxReinjects: number;
  /** Enable coalescing: buffer overlapping inbounds and reinject with context. */
  coalesce: boolean;
  /** Claim overlapping inbounds via inbound_claim while a run is active. */
  claimWhileActive: boolean;
  /** Max messages in the pending buffer per channel. Ring buffer: oldest dropped. */
  maxBufferedMessages: number;
  /** TTL for pending buffer entries in ms. Expired entries are pruned before use. */
  pendingTtlMs: number;
}

export const DEFAULT_CONFIG: SpeedtrapConfig = {
  assumeUnknownToolsAreWrites: true,
  debug: false,
  maxReinjects: 3,
  coalesce: false,
  claimWhileActive: false,
  maxBufferedMessages: 20,
  pendingTtlMs: 900_000,
};

/**
 * A buffered inbound message claimed while a run was active.
 */
/** Inbound message shape as received from the hook (ts may be absent). */
export interface PendingInboundInput {
  ts?: number;
  sender?: string;
  content: string;
  messageId?: string;
}

/** Stored pending message with guaranteed timestamp. */
export interface PendingInbound {
  ts: number;
  sender?: string;
  content: string;
  messageId?: string;
}

/**
 * Per-agent-run state: write tracking and per-agent pending buffer.
 *
 * Each agent accumulates messages that arrived while IT was processing.
 * When agent A delivers, its response is buffered into all OTHER active
 * agents' pending lists. When agent B gets reinjected, it consumes its
 * own buffer (containing A's response). Agent C still has both A and B
 * in its buffer until it completes.
 */
export interface AgentRunState {
  agentId: string;
  channelKey: string;
  /** Timestamp when this run was created or last reinjected. Used for stale run cleanup. */
  startedAt: number;
  /** True if any message arrived on the channel after this run started. */
  channelDirty: boolean;
  hasWriteSideEffects: boolean;
  /** Names of write tools invoked during this run (for reinjection context). */
  writeToolNames: string[];
  /** How many times this run has been reinjected. */
  reinjectCount: number;
  /** Whether this run is currently active (between agent start and final decision). */
  active: boolean;
  /** Messages that arrived while this agent was processing. Per-agent, not per-channel. */
  pending: PendingInbound[];
}

/**
 * Decision returned by the coordinator after an agent completes.
 */
export type SpeedtrapDecision =
  | { action: "deliver" }
  | { action: "suppress" }
  | { action: "reinject"; context: string };
