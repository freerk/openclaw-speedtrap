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
 *
 * Normalization:
 *   Different hook contexts derive conversationId differently. Agent hooks
 *   (before_agent_start, after_agent_complete) get the raw value including
 *   type prefixes like "user:" or "channel:". The inbound_claim context
 *   strips these via deriveConversationId(). We strip type prefixes here
 *   so all hooks produce the same key for the same physical conversation.
 */

const CONVERSATION_TYPE_PREFIXES = ["user:", "channel:", "group:", "direct:"];

/** Build a physical channel key from hook context components (skip accountId). */
export function buildPhysicalChannelKey(channelId: string, conversationId?: string): string {
  let normalized = conversationId;
  if (normalized) {
    for (const prefix of CONVERSATION_TYPE_PREFIXES) {
      if (normalized.startsWith(prefix)) {
        normalized = normalized.slice(prefix.length);
        break;
      }
    }
  }
  return [channelId, normalized].filter(Boolean).join(":");
}
