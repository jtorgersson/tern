import { invoke } from "@tauri-apps/api/core";
import type { Account } from "$lib/types";

export type ConnectResource =
  | { kind: "chats" }
  | { kind: "teams" }
  | { kind: "members"; chatId: string }
  | { kind: "channels"; teamId: string }
  | { kind: "chat"; chatId: string }
  | { kind: "channel"; teamId: string; channelId: string }
  | { kind: "replies"; teamId: string; channelId: string; messageId: string };
export interface GraphPage<T> { value: T[]; "@odata.nextLink"?: string }
export interface ConnectMessage {
  id: string;
  createdDateTime: string;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  messageType?: string;
  subject?: string | null;
  body: { contentType: string; content: string };
  from?: { user?: { id: string; displayName: string }; application?: { displayName: string } };
  attachments?: { id: string; name?: string; contentUrl?: string }[];
  webUrl?: string;
}
export interface ConnectChat {
  id: string;
  topic: string | null;
  chatType: string;
  webUrl?: string;
  members?: { userId: string; displayName: string; email?: string }[];
  lastMessagePreview?: { body?: { content: string }; createdDateTime?: string; from?: ConnectMessage["from"] } | null;
  viewpoint?: { lastMessageReadDateTime?: string | null; isHidden?: boolean } | null;
}
export interface ConnectGroup { id: string; displayName: string; webUrl?: string }
export interface Conversation { title: string; resource: ConnectResource; webUrl?: string; members?: ConnectChat["members"] }

/** Compare instants, not ISO strings: Graph and local cursors can use different offsets. */
export function readCursor(...dates: (string | null | undefined)[]): number {
  return Math.max(0, ...dates.map(d => d ? Date.parse(d) || 0 : 0));
}
export function chatUnread(chat: ConnectChat, accountId: string, localRead?: string): boolean {
  const preview = chat.lastMessagePreview;
  if (!preview?.createdDateTime || `ms-${preview.from?.user?.id}` === accountId) return false;
  // Without either cursor the read state is unknown, rather than automatically unread.
  if (!localRead && !chat.viewpoint?.lastMessageReadDateTime) return false;
  return readCursor(preview.createdDateTime) > readCursor(localRead, chat.viewpoint?.lastMessageReadDateTime);
}
export function unreadMessages(messages: ConnectMessage[], accountId: string, cursor: number): ConnectMessage[] {
  return messages.filter(m => !m.deletedDateTime && m.messageType !== "systemEventMessage" &&
    `ms-${m.from?.user?.id}` !== accountId && readCursor(m.createdDateTime) > cursor);
}

export const connectApi = {
  people: (accountId: string, query: string) => invoke<GraphPage<ConnectPerson>>("connect_people", { accountId, query }),
  createChat: (accountId: string, userIds: string[], topic: string) => invoke<ConnectChat>("connect_create_chat", { accountId, userIds, topic }),
  search: (accountId: string, query: string, from = 0) => invoke<ConnectSearchResponse>("connect_search", { accountId, query, from }),
  message: (accountId: string, resource: ConnectResource, messageId: string) => invoke<ConnectMessage>("connect_message", { accountId, resource, messageId }),
  enable: (accountId: string) => invoke<Account>("connect_enable", { accountId }),
  list: <T>(accountId: string, resource: ConnectResource, next: string | null = null) =>
    invoke<GraphPage<T>>("connect_list", { accountId, resource, next }),
  send: (accountId: string, resource: ConnectResource, text: string) =>
    invoke<ConnectMessage>("connect_send", { accountId, resource, text }),
};

export function chatTitle(chat: ConnectChat, accountId: string): string {
  return chat.topic || chat.members?.filter(m => `ms-${m.userId}` !== accountId)
    .map(m => m.displayName || m.email).filter(Boolean).join(", ") ||
    (chat.chatType === "meeting" ? "Meeting chat" : "Chat");
}

/** Stable order and deduplication for overlapping Graph pages and polling. */
export function mergeMessages(previous: ConnectMessage[], incoming: ConnectMessage[]): ConnectMessage[] {
  const byId = new Map(previous.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime) || a.id.localeCompare(b.id));
}

/** For previews only. Message bodies are separately sanitized before rendering. */
export function previewText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

export interface ConnectPerson { id: string; displayName: string; mail?: string | null; userPrincipalName: string; userType?: string | null }
export interface ConnectSearchHit {
  hitId: string;
  summary: string;
  resource: {
    id: string; subject?: string; createdDateTime?: string; webUrl?: string;
    chatId?: string; replyToId?: string | null;
    channelIdentity?: { teamId?: string; channelId?: string };
    from?: { user?: { displayName?: string }; emailAddress?: { name?: string; address?: string } };
  };
}
export interface ConnectSearchResponse { value: { hitsContainers?: { hits?: ConnectSearchHit[]; moreResultsAvailable?: boolean }[] }[] }
export function searchPage(response: ConnectSearchResponse) {
  const containers = response.value.flatMap(v => v.hitsContainers ?? []);
  return { hits: containers.flatMap(c => c.hits ?? []), more: containers.some(c => c.moreResultsAvailable) };
}

/** Resolve search hits to native conversations, including channel replies when Graph supplies a parent. */
export function searchConversation(hit: ConnectSearchHit): Conversation | null {
  const r = hit.resource;
  const { teamId, channelId } = r.channelIdentity ?? {};
  let parent = r.replyToId;
  try { parent ||= new URL(r.webUrl ?? "").searchParams.get("parentMessageId"); } catch {}
  if (teamId && channelId) return {
    title: r.subject || "Channel conversation", webUrl: r.webUrl,
    resource: parent && parent !== r.id ? { kind: "replies", teamId, channelId, messageId: parent } : { kind: "channel", teamId, channelId },
  };
  if (r.chatId) return { title: r.subject || "Conversation", webUrl: r.webUrl, resource: { kind: "chat", chatId: r.chatId } };
  return null;
}

/** Bounded, attributed context shared by writing, email handoff, and meeting drafts. */
export function conversationText(messages: ConnectMessage[]): string {
  return messages.filter(m => !m.deletedDateTime).slice(-40).map(m =>
    `${m.from?.user?.displayName || m.from?.application?.displayName || "Teams"} (${m.createdDateTime}): ${m.body.contentType === "html" ? previewText(m.body.content) : m.body.content}`,
  ).join("\n\n").slice(-18000);
}
