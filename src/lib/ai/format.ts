// Compact, model-friendly renderings of mail objects. Mail content is untrusted and always wrapped in <email> tags.
import { isoWeek } from "$lib/util/fmt";
import type { Account, Addr, CalEvent, MessageFull, MessageSummary } from "../types";

export const BODY_LIMIT = 12_000;

export function addr(a: Addr | null | undefined): string {
  if (!a) return "";
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
}

export function addrs(list: Addr[] | null | undefined): string {
  return (list ?? []).map(addr).join(", ");
}

/** Escape anything that could close our wrapper tag early. */
function neutralize(s: string): string {
  return s.replace(/<\/?email\b/gi, (m) => m.replace("<", "‹"));
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** One-line JSON-able summary for tool results. */
export function compactSummary(m: MessageSummary) {
  return {
    id: m.id,
    account: m.accountId,
    from: addr(m.from),
    subject: truncate(m.subject, 160),
    date: m.receivedAt,
    unread: !m.isRead,
    flagged: m.isFlagged || undefined,
    attachments: m.hasAttachments || undefined,
    preview: truncate(m.preview, 200),
    ai: m.ai ? { category: m.ai.category, priority: m.ai.priority, summary: m.ai.summary } : undefined,
  };
}

export function emailBlock(m: MessageFull, limit = BODY_LIMIT): string {
  const body = m.bodyText || m.preview || "";
  const cut = body.length > limit;
  return [
    `<email id="${m.id}">`,
    `From: ${neutralize(addr(m.from))}`,
    `To: ${neutralize(addrs(m.to))}`,
    m.cc.length ? `Cc: ${neutralize(addrs(m.cc))}` : "",
    `Date: ${m.receivedAt}`,
    `Subject: ${neutralize(m.subject)}`,
    m.attachments.filter((a) => !a.isInline).length
      ? `Attachments: ${m.attachments.filter((a) => !a.isInline).map((a) => a.name).join(", ")}`
      : "",
    "",
    neutralize(cut ? body.slice(0, limit) : body),
    cut ? `\n[…truncated: ${body.length - limit} more characters not shown]` : "",
    `</email>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function summaryBlock(m: MessageSummary, key: string): string {
  return [
    `<email key="${key}">`,
    `From: ${neutralize(addr(m.from))}`,
    `Date: ${m.receivedAt}`,
    `Importance: ${m.importance}`,
    `Subject: ${neutralize(m.subject)}`,
    `Preview: ${neutralize(truncate(m.preview, 400))}`,
    `</email>`,
  ].join("\n");
}

/** Summary of a message the user sent (recipients instead of sender). */
export function sentBlock(m: MessageSummary, key: string): string {
  return [
    `<email key="${key}" sent_by_user="true">`,
    `To: ${neutralize(addrs(m.to))}`,
    `Date: ${m.receivedAt}`,
    `Subject: ${neutralize(m.subject)}`,
    `Preview: ${neutralize(truncate(m.preview, 300))}`,
    `</email>`,
  ].join("\n");
}

export function threadBlock(thread: MessageFull[], perMessage = 6_000): string {
  // Oldest first; give later messages the full budget, older ones get less.
  return thread
    .map((m, i) => emailBlock(m, i >= thread.length - 2 ? perMessage * 2 : perMessage))
    .join("\n\n");
}

export function accountsLine(accounts: Account[]): string {
  return accounts.map((a) => `${a.id}: ${a.displayName} <${a.email}>`).join("; ");
}

export function nowLine(): string {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const w = d.toLocaleDateString("en-US", { weekday: "long" });
  return `${d.toLocaleString("sv-SE", { timeZone: tz })} (${tz}, ${w}, ISO week ${isoWeek(d)}; 24-hour clock, weeks start Monday)`;
}

/** Compact JSON-able event for tool results. */
export function compactEvent(e: CalEvent) {
  return {
    id: e.id,
    account: e.accountId,
    subject: truncate(e.subject || "(no title)", 120),
    start: e.start,
    end: e.end,
    allDay: e.isAllDay || undefined,
    location: e.location || undefined,
    online: e.isOnline || undefined,
    organizer: e.organizer ? addr(e.organizer) : undefined,
    attendees: e.attendees.length ? e.attendees.slice(0, 12).map((a) => `${addr(a.addr)}${a.response !== "none" ? ` (${a.response})` : ""}`) : undefined,
    myResponse: e.response,
    cancelled: e.isCancelled || undefined,
    repeats: e.seriesMasterId ? true : undefined,
    showAs: e.showAs !== "busy" ? e.showAs : undefined,
    private: e.sensitivity === "private" || undefined,
  };
}
