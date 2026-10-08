import { invoke } from "@tauri-apps/api/core";
import type { Account } from "$lib/types";

export type ConnectResource =
  | { kind: "chats" }
  | { kind: "teams" }
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
  lastMessagePreview?: { body?: { content: string }; createdDateTime?: string } | null;
}
export interface ConnectGroup { id: string; displayName: string; webUrl?: string }
export interface Conversation { title: string; resource: ConnectResource; webUrl?: string }

export const connectApi = {
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
