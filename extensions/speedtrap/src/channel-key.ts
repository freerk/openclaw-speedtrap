/**
 * Channel key normalization.
 *
 * Build a physical channel key from channelId + accountId + conversationId.
 * Including accountId scopes state to the bot account that received the
 * message, preventing cross-agent contamination in DMs (where different
 * bots share the same conversationId for the same human user).
 *
 * For shared channels, each bot account fires its own message_received
 * and inbound_claim with its own accountId, so per-account scoping works
 * naturally without special-casing DMs vs channels.
 */

/** Build a physical channel key from hook context components. */
export function buildPhysicalChannelKey(
  channelId: string,
  conversationId?: string,
  accountId?: string,
): string {
  return [channelId, accountId, conversationId].filter(Boolean).join(":");
}
