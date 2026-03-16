/**
 * Channel key normalization.
 *
 * Build a physical channel key from channelId + conversationId,
 * skipping accountId. All hooks now receive both fields via context,
 * so there is no need to parse or strip core-built channelKeys.
 *
 * Multi-agent setups use different accountIds for the same physical
 * channel (e.g. "slack:default:channel:C0..." vs "slack:conor:channel:C0...").
 * By keying on channelId + conversationId only, all agents see the same
 * physical channel regardless of which bot account they use.
 */

/** Build a physical channel key from hook context components (skip accountId). */
export function buildPhysicalChannelKey(channelId: string, conversationId?: string): string {
  return [channelId, conversationId].filter(Boolean).join(":");
}
