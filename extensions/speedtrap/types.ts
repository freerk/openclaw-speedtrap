/**
 * Speedtrap — Types
 *
 * Minimal state model: per-channel timestamps + per-agent-run metadata.
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
  debug: true,
  maxReinjects: 3,
};

/**
 * Per-channel state: just a timestamp of the last message seen.
 */
export type ChannelState = {
  channelKey: string;
  lastMessageTimestamp: number;
};

/**
 * Per-agent-run state: snapshot of channel timestamp at start + write tracking.
 */
export type AgentRunState = {
  agentId: string;
  channelKey: string;
  startedAt: number;
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
