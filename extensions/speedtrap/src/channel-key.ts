/**
 * Channel key normalization.
 *
 * Core builds channelKey as [provider, accountId, to].join(":").
 * Multi-agent setups use different accountIds for the same physical channel
 * (e.g. "slack:default:channel:C0..." vs "slack:conor:channel:C0...").
 * Speedtrap needs to treat these as the same channel, so we strip accountId.
 *
 * See CHANNEL_KEY_NORMALIZATION.md for the long-term solution (Option B).
 */

/** Build a physical channel key from message_received components (skip accountId). */
export function buildPhysicalChannelKey(channelId: string, conversationId?: string): string {
  return [channelId, conversationId].filter(Boolean).join(":");
}

/**
 * Strip the accountId segment from a core-built channelKey.
 *
 * Core format: "{channelId}:{accountId}:{to}" where channelId = provider name.
 * We strip the first segment after the provider to produce "{channelId}:{to}",
 * matching what buildPhysicalChannelKey produces from message_received.
 *
 * Assumes accountId is a single segment (no colons). This holds for all known
 * providers (Slack, Telegram, WhatsApp, Discord, Teams, Matrix, etc.).
 */
export function stripAccountFromChannelKey(channelKey: string, channelId: string): string {
  const prefix = `${channelId}:`;
  if (!channelKey.startsWith(prefix)) return channelKey;
  const afterProvider = channelKey.slice(prefix.length);
  const firstColon = afterProvider.indexOf(":");
  if (firstColon === -1) return channelKey; // no account segment present
  return `${channelId}:${afterProvider.slice(firstColon + 1)}`;
}
