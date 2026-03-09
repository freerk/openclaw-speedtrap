/**
 * Speedtrap v2 — Types
 *
 * Minimal state model: per-channel timestamps + per-agent-run metadata.
 */

export type SpeedtrapV2Config = {
  /**
   * When true (default), unknown tools are assumed to have write side effects.
   * This is the conservative default — unknown tools force delivery even if
   * the channel moved, which is safer than silently discarding responses
   * that had side effects.
   */
  assumeUnknownToolsAreWrites: boolean;
  /** Log all Speedtrap decisions to console. */
  debug: boolean;
};

export const DEFAULT_CONFIG: SpeedtrapV2Config = {
  assumeUnknownToolsAreWrites: true,
  debug: true,
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
};
