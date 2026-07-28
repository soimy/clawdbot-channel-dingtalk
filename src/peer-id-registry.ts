/**
 * Peer ID Registry
 *
 * Maps lowercased peer/session keys back to their original case-sensitive
 * DingTalk conversationId values. DingTalk conversationIds are base64-encoded
 * and therefore case-sensitive, but the framework may lowercase session keys
 * internally. This registry preserves the original casing so outbound messages
 * can be delivered correctly.
 */

const peerIdMap = new Map<string, string>();

/**
 * Register an original peer ID, keyed by its lowercased form.
 */
export function registerPeerId(originalId: string): void {
  if (!originalId) {
    return;
  }
  peerIdMap.set(originalId.toLowerCase(), originalId);
}

/**
 * Resolve a possibly-lowercased peer ID back to its original casing.
 *
 * Returns the original if found, otherwise returns the input as-is.
 */
export function resolveOriginalPeerId(id: string): string {
  if (!id) {
    return id;
  }

  return peerIdMap.get(id.toLowerCase()) || id;
}

/**
 * Clear the registry (for testing or shutdown).
 */
export function clearPeerIdRegistry(): void {
  peerIdMap.clear();
}
