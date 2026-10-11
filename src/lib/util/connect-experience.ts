import { previewText, type ConnectMessage } from "../connect";

export const MESSAGE_LIMIT = 20000;
export function messageText(message: ConnectMessage): string {
  return message.body.contentType === "html" ? previewText(message.body.content) : message.body.content;
}
export function matchesMessage(message: ConnectMessage, query: string): boolean {
  if (message.deletedDateTime) return false;
  return `${message.from?.user?.displayName || message.from?.application?.displayName || ""} ${message.subject || ""} ${messageText(message)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
export function quotedText(quote: ConnectMessage | undefined, draft: string): string {
  return quote ? `${quote.from?.user?.displayName || quote.from?.application?.displayName || "Teams"} wrote: “${messageText(quote).slice(0, 2000)}”\n\n${draft}` : draft;
}
export function dayKey(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export interface BriefCard { kind: "decision" | "action" | "question"; text: string; sourceIds: string[] }
export interface ConversationBrief { summary: string; cards: BriefCard[] }

/** Include complete, numbered sources only; the same snapshot validates returned citations. */
export function briefSources(messages: ConnectMessage[]): ConnectMessage[] {
  const recent = messages.filter(m => !m.deletedDateTime && m.messageType !== "systemEventMessage").slice(-40);
  const result: ConnectMessage[] = [];
  let remaining = 18000;
  for (const message of recent.reverse()) {
    const cost = JSON.stringify(message).length;
    if (cost > remaining) continue;
    result.unshift(message);
    remaining -= cost;
  }
  return result;
}
export function briefContext(messages: ConnectMessage[]): string {
  return JSON.stringify(messages.map(m => ({ id: m.id, author: m.from?.user?.displayName || m.from?.application?.displayName || "Teams", date: m.createdDateTime, text: messageText(m) })));
}
/** Reject malformed or invented citations instead of presenting them as evidence. */
export function parseBrief(value: string, sources: ConnectMessage[]): ConversationBrief {
  const parsed = JSON.parse(value.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim() || !Array.isArray(parsed.cards)) throw new Error("The brief could not be read. Please try again.");
  const ids = new Set(sources.map(m => m.id));
  const cards: BriefCard[] = parsed.cards.slice(0, 12).map((card: unknown) => {
    if (!card || typeof card !== "object") throw new Error("The brief contains an incomplete card. Please try again.");
    const c = card as Record<string, unknown>;
    if (!["decision", "action", "question"].includes(String(c.kind)) || typeof c.text !== "string" || !c.text.trim() || !Array.isArray(c.sourceIds) || !c.sourceIds.length || c.sourceIds.some(id => typeof id !== "string" || !ids.has(id))) throw new Error("The brief could not link its sources. Please try again.");
    return { kind: c.kind as BriefCard["kind"], text: c.text.slice(0, 1200), sourceIds: [...new Set(c.sourceIds as string[])] };
  });
  return { summary: parsed.summary.slice(0, 2000), cards };
}
