import type { Conversation, ConnectResource } from "$lib/connect";

export interface PinnedConversation { accountId: string; conversation: Conversation }

export function pinKey(accountId: string, resource: ConnectResource): string {
  if (resource.kind === "chat") return JSON.stringify([accountId, "chat", resource.chatId]);
  if (resource.kind === "channel") return JSON.stringify([accountId, "channel", resource.teamId, resource.channelId]);
  return "";
}

/** Local preferences may have been written by another version. Keep only usable shortcuts. */
export function parsePins(raw: string): PinnedConversation[] {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.filter((pin): pin is PinnedConversation => {
      const c = pin?.conversation, r = c?.resource;
      if (typeof pin?.accountId !== "string" || !pin.accountId || typeof c?.title !== "string" || !r) return false;
      if (!(r.kind === "chat" && typeof r.chatId === "string" && r.chatId) &&
          !(r.kind === "channel" && typeof r.teamId === "string" && r.teamId && typeof r.channelId === "string" && r.channelId)) return false;
      const key = pinKey(pin.accountId, r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 100).map(({ accountId, conversation: c }) => ({
      accountId, conversation: { title: c.title, resource: c.resource },
    }));
  } catch { return []; }
}
