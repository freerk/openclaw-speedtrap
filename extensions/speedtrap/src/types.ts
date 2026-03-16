/**
 * Speedtrap — Types
 *
 * Minimal state model: per-channel message counters + per-agent-run metadata.
 */

export type SpeedtrapConfig = {
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
};

export const DEFAULT_CONFIG: SpeedtrapConfig = {
  assumeUnknownToolsAreWrites: true,
  debug: false,
  maxReinjects: 3,
};

/**
 * Per-channel state: monotonic counter of messages received.
 * Incremented on each message_received event.
 */
export type ChannelState = {
  channelKey: string;
  messageCount: number;
};

/**
 * Per-agent-run state: snapshot of channel message count at start + write tracking.
 */
export type AgentRunState = {
  agentId: string;
  channelKey: string;
  /** Channel message count when the agent started processing. */
  snapshotMessageCount: number;
  hasWriteSideEffects: boolean;
  /** Names of write tools invoked during this run (for reinjection context). */
  writeToolNames: string[];
  /** How many times this run has been reinjected. */
  reinjectCount: number;
};

/**
 * Decision returned by the coordinator after an agent completes.
 */
export type SpeedtrapDecision =
  | { action: "deliver" }
  | { action: "suppress" }
  | { action: "reinject"; context: string };
