/**
 * Speedtrap — Types
 *
 * Absorb + reinject model: per-scope state tracking buffered messages.
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
 * Per-scope state: tracks whether an agent is processing for a given
 * agent+channel combination, and buffers messages that arrive during processing.
 */
export type ScopeState = {
  scopeKey: string;
  agentId: string;
  channelKey: string;
  /** Whether an agent is currently processing for this scope. */
  processing: boolean;
  /** Messages that arrived while the agent was processing. */
  bufferedMessages: Array<{ content: string; timestamp: number }>;
  /** Names of write tools invoked during this run (for reinjection context). */
  writeToolNames: string[];
  hasWriteSideEffects: boolean;
  /** How many times this scope has been reinjected. */
  reinjectCount: number;
};

/**
 * Decision returned by the coordinator after an agent completes.
 */
export type SpeedtrapDecision =
  | { action: "deliver" }
  | { action: "reinject"; context: string };
