// Compact, model-friendly renderings of mail objects. Mail content is untrusted and always wrapped in <email> tags.
import type { Account, Addr, MessageFull, MessageSummary } from "../types";

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
  return `${d.toLocaleString("sv-SE", { timeZone: tz })} (${tz}, ${d.toLocaleDateString("en-US", { weekday: "long" })})`;
}
