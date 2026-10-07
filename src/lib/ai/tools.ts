// Agent tool definitions: zod schemas (validated before running), labels, approval policy, executors.
import * as z from "zod";
import { api } from "../api";
import type {
  Account,
  AiCategory,
  CalEvent,
  EventDraft,
  EventPatch,
  Recurrence,
  MessageSummary,
  MessageView,
  OutgoingMessage,
  WellKnownFolder,
} from "../types";
import type { ToolSpec } from "./backend";
import { settings } from "./config";
import { addr, compactEvent, compactSummary, emailBlock, threadBlock, truncate } from "./format";
import { hhmm, weekdayDayMonth } from "$lib/util/fmt";

export type Approval = "never" | "safe" | "always";

export type UiAction =
  | { kind: "open_message"; id: string }
  | { kind: "compose"; draft: Partial<OutgoingMessage> }
  | { kind: "show_results"; title: string; ids: string[] }
  | { kind: "open_event"; id: string };

export interface ToolCtx {
  ui(action: UiAction): void;
  accounts(): Promise<Account[]>;
  /** Messages the agent has seen this session (for labels / approval previews). */
  known: Map<string, MessageSummary>;
  /** Calendar events the agent has seen this session. */
  knownEvents: Map<string, CalEvent>;
  defaultAccountId: string | null;
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  approval: Approval;
  label(input: z.infer<S>, ctx: ToolCtx): string;
  preview?(input: z.infer<S>, ctx: ToolCtx): string | Promise<string>;
  run(input: z.infer<S>, ctx: ToolCtx): Promise<unknown>;
}

const CATEGORIES = [
  "needs_reply", "action", "fyi", "calendar", "newsletter", "notification", "receipt", "spam",
] as const satisfies readonly AiCategory[];

const Ids = z.array(z.string()).min(1).max(200).describe("Message ids");
const Limit = z.number().int().min(1).max(50).optional().describe("Max results (default 20)");
const AccountId = z.string().optional().describe("Restrict to this account id (omit for all accounts)");
const Recipient = z.object({ name: z.string().optional(), email: z.string() });

const ComposeInput = z.object({
  mode: z.enum(["new", "reply", "replyAll", "forward"]).describe("new message, or reply/replyAll/forward to ref_message_id"),
  ref_message_id: z.string().optional().describe("Required for reply, replyAll and forward"),
  account_id: z.string().optional().describe("Account to send from (defaults to the referenced message's account)"),
  to: z.array(Recipient).optional().describe("Recipients (for replies, defaults to the original sender(s))"),
  cc: z.array(Recipient).optional(),
  subject: z.string().optional().describe("Subject (replies/forwards default to Re:/Fw: of the original)"),
  body: z.string().describe("Plain-text body, without signature"),
});
type ComposeInput = z.infer<typeof ComposeInput>;

function def<S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

function remember(ctx: ToolCtx, list: MessageSummary[]) {
  for (const m of list) ctx.known.set(m.id, m);
}

function describeIds(ids: string[], ctx: ToolCtx, max = 8): string {
  const lines = ids.slice(0, max).map((id) => {
    const m = ctx.known.get(id);
    return m ? `• ${addr(m.from)} — ${truncate(m.subject || "(no subject)", 80)}` : `• message ${truncate(id, 16)}`;
  });
  if (ids.length > max) lines.push(`…and ${ids.length - max} more`);
  return lines.join("\n");
}

function n(ids: string[], word = "message"): string {
  return `${ids.length} ${word}${ids.length === 1 ? "" : "s"}`;
}

const WELL_KNOWN: Record<string, WellKnownFolder> = {
  inbox: "inbox", sent: "sentitems", drafts: "drafts", archive: "archive", trash: "deleteditems", junk: "junkemail",
};

export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function buildOutgoing(i: ComposeInput, ctx: ToolCtx): Promise<Partial<OutgoingMessage>> {
  let accountId = i.account_id ?? null;
  let subject = i.subject;
  if (i.mode !== "new") {
    if (!i.ref_message_id) throw new Error(`ref_message_id is required for mode ${i.mode}`);
    const ref = await api.message(i.ref_message_id);
    accountId ??= ref.accountId;
    if (!subject) {
      const prefix = i.mode === "forward" ? "Fw: " : "Re: ";
      subject = /^(re|fw|fwd|sv|vb):/i.test(ref.subject) ? ref.subject : prefix + ref.subject;
    }
  }
  accountId ??= ctx.defaultAccountId ?? (await ctx.accounts())[0]?.id ?? null;
  if (!accountId) throw new Error("No account available to send from");
  const toAddr = (r: { name?: string; email: string }) => ({ name: r.name ?? "", email: r.email });
  return {
    accountId,
    mode: i.mode,
    refMessageId: i.ref_message_id ?? null,
    to: (i.to ?? []).map(toAddr),
    cc: (i.cc ?? []).map(toAddr),
    bcc: [],
    subject: subject ?? "",
    bodyHtml: textToHtml(i.body),
  };
}

const LocalIso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "local ISO like 2026-10-08T14:00:00 (no offset)");
const Scope = z.enum(["occurrence", "series"]).optional().describe("For recurring events: just this occurrence (default) or the whole series");
const WeekdayZ = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const RecurrenceZ = z
  .object({
    pattern: z.object({
      type: z.enum(["daily", "weekly", "absoluteMonthly", "relativeMonthly", "absoluteYearly", "relativeYearly"]),
      interval: z.number().int().min(1).max(99).describe("Every N days/weeks/months/years"),
      daysOfWeek: z.array(WeekdayZ).optional().describe("weekly / relativeMonthly"),
      dayOfMonth: z.number().int().min(1).max(31).optional().describe("absoluteMonthly / absoluteYearly"),
      month: z.number().int().min(1).max(12).optional().describe("yearly"),
      index: z.enum(["first", "second", "third", "fourth", "last"]).optional().describe("relativeMonthly: which weekday of the month"),
    }),
    range: z.object({
      type: z.enum(["noEnd", "endDate", "numbered"]),
      endDate: z.string().optional().describe("YYYY-MM-DD when type=endDate"),
      numberOfOccurrences: z.number().int().min(1).max(999).optional(),
    }),
  })
  .describe("Repeat rule (Microsoft Graph patternedRecurrence). Weeks start on Monday.");
const sec = (s: string) => (s.length === 16 ? s + ":00" : s);

/** Sync window of the local cache (mirror of calendar.rs); outside it the agent must fetch from the server first. */
const WINDOW_BACK_DAYS = 14;
const WINDOW_AHEAD_DAYS = 45;
function insideWindow(from: string, to: string): boolean {
  const now = new Date();
  const lo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - WINDOW_BACK_DAYS);
  const hi = new Date(now.getFullYear(), now.getMonth(), now.getDate() + WINDOW_AHEAD_DAYS);
  return new Date(from) >= lo && new Date(to) <= hi;
}

function whenText(start: string, end: string, allDay = false): string {
  const s = new Date(start);
  const e = new Date(end);
  const day = weekdayDayMonth(s);
  if (allDay) return `${day} · all day`;
  const t = (d: Date) => hhmm(d);
  const mins = Math.round((e.getTime() - s.getTime()) / 60_000);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `${mins}m`;
  return `${day}, ${t(s)} – ${t(e)} (${dur})`;
}

function recurrenceText(r: Recurrence): string {
  const p = r.pattern;
  const n = p.interval ?? 1;
  const unit = p.type === "daily" ? "day" : p.type === "weekly" ? "week" : p.type.includes("Monthly") ? "month" : "year";
  let s = `every ${n === 1 ? unit : `${n} ${unit}s`}`;
  if (p.daysOfWeek?.length) s += ` on ${p.daysOfWeek.map((d) => d.slice(0, 3)).join(", ")}`;
  if (p.dayOfMonth && unit !== "week") s += ` on day ${p.dayOfMonth}`;
  if (r.range.type === "endDate" && r.range.endDate) s += ` until ${r.range.endDate}`;
  if (r.range.type === "numbered" && r.range.numberOfOccurrences) s += `, ${r.range.numberOfOccurrences} times`;
  return s;
}

async function resolveAccount(id: string | undefined, ctx: ToolCtx): Promise<string> {
  const acc = id ?? ctx.defaultAccountId ?? (await ctx.accounts())[0]?.id;
  if (!acc) throw new Error("No account available");
  return acc;
}

export const TOOLS = [
  def({
    name: "search_messages",
    description: "Full-text search over cached mail in all folders (subject, sender name/address, preview, body). Returns newest first.",
    schema: z.object({ query: z.string().min(1).describe("Search words; sender names or addresses work too"), account_id: AccountId, limit: Limit }),
    approval: "never",
    label: (i) => `Searching “${truncate(i.query, 40)}”`,
    async run(i, ctx) {
      const list = await api.messages({ view: { kind: "search", query: i.query }, accountId: i.account_id ?? null, limit: i.limit ?? 20 });
      remember(ctx, list);
      return { count: list.length, messages: list.map(compactSummary) };
    },
  }),
  def({
    name: "list_messages",
    description: "List messages in a mailbox view, newest first. view: inbox|sent|drafts|archive|trash|junk (unified across accounts unless account_id), flagged, category (inbox messages with an AI triage category), or folder (by folder_id).",
    schema: z.object({
      view: z.enum(["inbox", "sent", "drafts", "archive", "trash", "junk", "flagged", "category", "folder"]),
      category: z.enum(CATEGORIES).optional().describe("Required when view=category"),
      folder_id: z.string().optional().describe("Required when view=folder"),
      account_id: AccountId,
      unread_only: z.boolean().optional(),
      before: z.string().optional().describe("ISO date cursor: only messages received before this"),
      limit: Limit,
    }),
    approval: "never",
    label: (i) => `Listing ${i.unread_only ? "unread " : ""}${i.view === "category" ? (i.category ?? "").replace("_", " ") : i.view}`,
    async run(i, ctx) {
      let view: MessageView;
      if (i.view === "flagged") view = { kind: "flagged" };
      else if (i.view === "category") {
        if (!i.category) throw new Error("category is required when view=category");
        view = { kind: "category", category: i.category };
      } else if (i.view === "folder") {
        if (!i.folder_id) throw new Error("folder_id is required when view=folder");
        view = { kind: "folder", folderId: i.folder_id };
      } else view = { kind: "unified", wellKnown: WELL_KNOWN[i.view] };
      const list = await api.messages({ view, accountId: i.account_id ?? null, unreadOnly: i.unread_only ?? false, before: i.before ?? null, limit: i.limit ?? 20 });
      remember(ctx, list);
      return { count: list.length, messages: list.map(compactSummary) };
    },
  }),
  def({
    name: "read_message",
    description: "Read one message in full (headers, attachments list, body as text).",
    schema: z.object({ id: z.string() }),
    approval: "never",
    label: (i, ctx) => {
      const m = ctx.known.get(i.id);
      return m ? `Reading “${truncate(m.subject || "(no subject)", 40)}”` : "Reading message";
    },
    async run(i, ctx) {
      const m = await api.message(i.id);
      ctx.known.set(m.id, m);
      return emailBlock(m);
    },
  }),
  def({
    name: "read_thread",
    description: "Read the whole conversation a message belongs to, oldest first.",
    schema: z.object({ id: z.string().describe("Any message id in the thread") }),
    approval: "never",
    label: (i, ctx) => {
      const m = ctx.known.get(i.id);
      return m ? `Reading thread “${truncate(m.subject || "(no subject)", 36)}”` : "Reading thread";
    },
    async run(i, ctx) {
      const t = await api.thread(i.id);
      remember(ctx, t);
      return `${t.length} message(s) in thread:\n\n${threadBlock(t, 4_000)}`;
    },
  }),
  def({
    name: "list_folders",
    description: "List mail folders with unread/total counts.",
    schema: z.object({ account_id: AccountId }),
    approval: "never",
    label: () => "Listing folders",
    async run(i) {
      const fs = await api.folders(i.account_id ?? null);
      return fs.map((f) => ({ id: f.id, account: f.accountId, name: f.name, wellKnown: f.wellKnown ?? undefined, unread: f.unread, total: f.total }));
    },
  }),
  def({
    name: "list_accounts",
    description: "List the user's accounts: their own, plus shared mailboxes and colleagues' calendars they have opened (kind).",
    schema: z.object({}),
    approval: "never",
    label: () => "Checking accounts",
    async run(_i, ctx) {
      return (await ctx.accounts()).map((a) => ({
        id: a.id,
        name: a.displayName,
        email: a.email,
        status: a.status,
        kind: a.ownerId ? (a.syncMail ? "shared mailbox" : "shared calendar (no mail)") : "own",
      }));
    },
  }),
  def({
    name: "archive",
    description: "Archive messages (move to the Archive folder).",
    schema: z.object({ ids: Ids }),
    approval: "safe",
    label: (i) => `Archiving ${n(i.ids)}`,
    preview: (i, ctx) => `Archive ${n(i.ids)}:\n${describeIds(i.ids, ctx)}`,
    async run(i) {
      await api.move(i.ids, "archive");
      return `Archived ${n(i.ids)}.`;
    },
  }),
  def({
    name: "mark_read",
    description: "Mark messages read (or unread with read=false).",
    schema: z.object({ ids: Ids, read: z.boolean().optional().describe("Default true") }),
    approval: "safe",
    label: (i) => `Marking ${n(i.ids)} ${i.read === false ? "unread" : "read"}`,
    preview: (i, ctx) => `Mark ${n(i.ids)} as ${i.read === false ? "unread" : "read"}:\n${describeIds(i.ids, ctx)}`,
    async run(i) {
      await api.setRead(i.ids, i.read ?? true);
      return `Marked ${n(i.ids)} ${i.read === false ? "unread" : "read"}.`;
    },
  }),
  def({
    name: "flag",
    description: "Flag (star) messages, or unflag with flagged=false.",
    schema: z.object({ ids: Ids, flagged: z.boolean().optional().describe("Default true") }),
    approval: "safe",
    label: (i) => `${i.flagged === false ? "Unflagging" : "Flagging"} ${n(i.ids)}`,
    preview: (i, ctx) => `${i.flagged === false ? "Unflag" : "Flag"} ${n(i.ids)}:\n${describeIds(i.ids, ctx)}`,
    async run(i) {
      await api.setFlag(i.ids, i.flagged ?? true);
      return `${i.flagged === false ? "Unflagged" : "Flagged"} ${n(i.ids)}.`;
    },
  }),
  def({
    name: "move",
    description: "Move messages to a folder: a folder id from list_folders, or one of: inbox, archive, junkemail.",
    schema: z.object({ ids: Ids, destination: z.string() }),
    approval: "safe",
    label: (i) => `Moving ${n(i.ids)}`,
    preview: (i, ctx) => `Move ${n(i.ids)} to ${i.destination}:\n${describeIds(i.ids, ctx)}`,
    async run(i) {
      await api.move(i.ids, i.destination);
      return `Moved ${n(i.ids)} to ${i.destination}.`;
    },
  }),
  def({
    name: "delete",
    description: "Delete messages (moves them to Deleted Items). Always asks the user to confirm.",
    schema: z.object({ ids: Ids }),
    approval: "always",
    label: (i) => `Deleting ${n(i.ids)}`,
    preview: (i, ctx) => `Delete ${n(i.ids)}:\n${describeIds(i.ids, ctx)}`,
    async run(i) {
      await api.remove(i.ids);
      return `Deleted ${n(i.ids)}.`;
    },
  }),
  def({
    name: "compose_draft",
    description: "Open the composer pre-filled with a draft for the user to review and send themselves. Preferred over send_email.",
    schema: ComposeInput,
    approval: "never",
    label: (i) => (i.mode === "new" ? "Drafting a new email" : `Drafting ${i.mode === "forward" ? "a forward" : "a reply"}`),
    async run(i, ctx) {
      ctx.ui({ kind: "compose", draft: await buildOutgoing(i, ctx) });
      return "Draft opened in the composer for the user to review. It has NOT been sent.";
    },
  }),
  def({
    name: "send_email",
    description: "Send an email immediately. Only when the user explicitly asked to send without reviewing. Always asks the user to confirm.",
    schema: ComposeInput,
    approval: "always",
    label: (i) => (i.mode === "new" ? "Sending email" : `Sending ${i.mode === "forward" ? "forward" : "reply"}`),
    async preview(i, ctx) {
      const o = await buildOutgoing(i, ctx);
      const to = (o.to ?? []).map(addr).join(", ") || (i.mode === "new" ? "(none)" : "original sender(s)");
      return [`To: ${to}`, o.cc?.length ? `Cc: ${o.cc.map(addr).join(", ")}` : "", `Subject: ${o.subject}`, "", i.body]
        .filter((l, idx) => l !== "" || idx === 3)
        .join("\n");
    },
    async run(i, ctx) {
      const o = await buildOutgoing(i, ctx);
      if (o.mode === "new" && !o.to?.length) throw new Error("A new message needs at least one recipient");
      await api.send(o as OutgoingMessage);
      return "Sent.";
    },
  }),
  def({
    name: "show_results",
    description: "Show a set of messages in the main message list with a title (e.g. after a search), so the user can work through them.",
    schema: z.object({ title: z.string(), ids: z.array(z.string()).max(200) }),
    approval: "never",
    label: (i) => `Showing ${n(i.ids)}`,
    async run(i, ctx) {
      ctx.ui({ kind: "show_results", title: i.title, ids: i.ids });
      return `Showing ${n(i.ids)} to the user.`;
    },
  }),
  def({
    name: "snooze_messages",
    description: "Snooze messages: hide them from the inbox until a local date-time, when they come back unread with a notification. Use for 'remind me about this Monday', 'deal with these after the board meeting'.",
    schema: z.object({ ids: Ids, until: LocalIso.describe("When they should come back, local ISO") }),
    approval: "safe",
    label: (i) => `Snoozing ${n(i.ids)} until ${i.until.slice(0, 16).replace("T", " ")}`,
    preview: (i, ctx) => `Snooze until ${i.until.slice(0, 16).replace("T", " ")}:\n${describeIds(i.ids, ctx)}`,
    async run(i) {
      const at = new Date(sec(i.until));
      if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) throw new Error("until must be in the future");
      await api.snooze(i.ids, at.toISOString());
      return `Snoozed ${n(i.ids)}.`;
    },
  }),
  def({
    name: "open_message",
    description: "Open a message in the reader pane.",
    schema: z.object({ id: z.string() }),
    approval: "never",
    label: () => "Opening message",
    async run(i, ctx) {
      ctx.ui({ kind: "open_message", id: i.id });
      return "Opened.";
    },
  }),

  // ---------------- calendar ----------------
  def({
    name: "list_events",
    description: "List calendar events between two local date-times, from all of the user's calendars (any range up to a year; ranges far from today are fetched from the server). Includes attendees, the user's response, location, online flag, calendar and whether it repeats.",
    schema: z.object({
      from: LocalIso.describe("Start of range, local ISO"),
      to: LocalIso.describe("End of range (exclusive), local ISO"),
      account_id: AccountId,
    }),
    approval: "never",
    label: (i) => `Checking calendar ${i.from.slice(0, 10)} → ${i.to.slice(0, 10)}`,
    async run(i, ctx) {
      const from = sec(i.from);
      const to = sec(i.to);
      if (to <= from) throw new Error("to must be after from");
      const list = insideWindow(from, to) ? await api.calendarEvents(from, to, i.account_id ?? null) : await api.calendarFetchRange(from, to, i.account_id ?? null);
      for (const e of list) ctx.knownEvents.set(e.id, e);
      const cals = await api.calendars(null);
      const calName = new Map(cals.map((c) => [c.id, c.name]));
      return { count: list.length, events: list.map((e) => ({ ...compactEvent(e), calendar: calName.get(e.calendarId) || undefined })) };
    },
  }),
  def({
    name: "list_calendars",
    description: "The user's calendars per account (name, id, default, editable, shared owner). Use calendar_id with create_event to put something in a specific calendar.",
    schema: z.object({ account_id: AccountId }),
    approval: "never",
    label: () => "Listing calendars",
    async run(i) {
      const cals = await api.calendars(i.account_id ?? null);
      return { calendars: cals.map((c) => ({ id: c.id, account: c.accountId, name: c.name, default: c.isDefault || undefined, editable: c.canEdit, sharedBy: c.owner || undefined })) };
    },
  }),
  def({
    name: "find_free_times",
    description: "Find free slots for a meeting of the given length within a range, inside the user's working hours. Pass attendees' emails to check their availability too (works for people in the same organisation).",
    schema: z.object({
      attendees: z.array(z.string()).optional().describe("Other people's email addresses to check (omit for just the user)"),
      from: LocalIso.describe("Range start, local ISO"),
      to: LocalIso.describe("Range end, local ISO"),
      duration_mins: z.number().int().min(5).max(600).describe("Meeting length in minutes"),
      account_id: AccountId,
    }),
    approval: "never",
    label: (i) => `Finding ${i.duration_mins} min${i.attendees?.length ? ` with ${i.attendees.length} ${i.attendees.length === 1 ? "person" : "people"}` : ""}`,
    async run(i, ctx) {
      const accountId = await resolveAccount(i.account_id, ctx);
      const cal = settings().calendar;
      const slots = await api.freeSlots({
        accountId,
        attendees: i.attendees ?? [],
        from: i.from,
        to: i.to,
        durationMins: i.duration_mins,
        workStart: cal?.workStart,
        workEnd: cal?.workEnd,
      });
      return {
        count: slots.length,
        workingHours: cal ? `${cal.workStart}–${cal.workEnd}` : undefined,
        slots: slots.slice(0, 30).map((s) => ({ start: s.start, end: s.end, label: whenText(s.start, s.end) })),
        note: slots.length ? undefined : "No free slots in that range within working hours; try a wider range.",
      };
    },
  }),
  def({
    name: "create_event",
    description: "Create a calendar event (an invitation is sent when attendees are given). Always asks the user to confirm. Propose times in chat first unless the user already named the exact time.",
    schema: z.object({
      subject: z.string().min(1),
      start: LocalIso,
      end: LocalIso,
      attendees: z.array(Recipient).optional().describe("People to invite"),
      location: z.string().optional(),
      body: z.string().optional().describe("Plain-text description / agenda"),
      is_online: z.boolean().optional().describe("Add a Teams meeting link (default true when there are attendees)"),
      is_all_day: z.boolean().optional(),
      optional_attendees: z.array(Recipient).optional(),
      recurrence: RecurrenceZ.optional(),
      show_as: z.enum(["free", "tentative", "busy", "oof", "workingElsewhere"]).optional().describe("Default busy; use free for reminders/placeholders, oof for vacation"),
      reminder_minutes: z.number().int().min(-1).max(10080).optional().describe("Reminder before start; -1 = none; omit for the user's default"),
      is_private: z.boolean().optional(),
      calendar_id: z.string().optional().describe("From list_calendars; default calendar when omitted"),
      account_id: AccountId,
    }),
    approval: "always",
    label: (i) => `Creating “${truncate(i.subject, 36)}”`,
    preview: (i) => {
      const lines = [
        `${i.subject}`,
        `When: ${whenText(i.start, i.end, i.is_all_day)}`,
        i.recurrence ? `Repeats: ${recurrenceText(i.recurrence as Recurrence)}` : "",
        i.location ? `Where: ${i.location}` : "",
        (i.is_online ?? (i.attendees?.length ?? 0) > 0) ? "Teams meeting link will be added" : "",
        i.attendees?.length ? `Invite: ${i.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ")}` : "No attendees (personal event)",
        i.optional_attendees?.length ? `Optional: ${i.optional_attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ")}` : "",
        i.show_as && i.show_as !== "busy" ? `Show as: ${i.show_as}` : "",
        i.is_private ? "Private" : "",
        i.body ? `\n${truncate(i.body, 400)}` : "",
      ];
      return lines.filter(Boolean).join("\n");
    },
    async run(i, ctx) {
      if (i.end <= i.start) throw new Error("end must be after start");
      const draft: EventDraft = {
        accountId: await resolveAccount(i.account_id, ctx),
        calendarId: i.calendar_id ?? null,
        subject: i.subject,
        start: sec(i.start),
        end: sec(i.end),
        isAllDay: i.is_all_day ?? false,
        location: i.location ?? null,
        body: i.body ?? null,
        attendees: (i.attendees ?? []).map((a) => ({ name: a.name ?? "", email: a.email })),
        optionalAttendees: (i.optional_attendees ?? []).map((a) => ({ name: a.name ?? "", email: a.email })),
        isOnline: i.is_online ?? (i.attendees?.length ?? 0) > 0,
        showAs: i.show_as ?? null,
        reminderMinutes: i.reminder_minutes ?? settings().calendar?.defaultReminderMinutes ?? null,
        sensitivity: i.is_private ? "private" : null,
        recurrence: (i.recurrence as Recurrence | undefined) ?? null,
      };
      const ev = await api.eventCreate(draft);
      ctx.knownEvents.set(ev.id, ev);
      ctx.ui({ kind: "open_event", id: ev.id });
      return { created: compactEvent(ev) };
    },
  }),
  def({
    name: "update_event",
    description: "Change an existing event (by id from list_events): move it, rename it, change attendees, location, notes, repeat rule, show-as, reminder. Attendees get an update automatically when the user organizes the meeting. Always asks the user to confirm.",
    schema: z.object({
      event_id: z.string(),
      scope: Scope,
      subject: z.string().optional(),
      start: LocalIso.optional(),
      end: LocalIso.optional(),
      is_all_day: z.boolean().optional(),
      location: z.string().nullable().optional().describe("null clears"),
      body: z.string().nullable().optional().describe("Plain-text notes; null clears"),
      attendees: z.array(Recipient).optional().describe("Replaces the required attendee list"),
      optional_attendees: z.array(Recipient).optional(),
      is_online: z.boolean().optional(),
      show_as: z.enum(["free", "tentative", "busy", "oof", "workingElsewhere"]).optional(),
      reminder_minutes: z.number().int().min(-1).max(10080).optional().describe("-1 = none"),
      is_private: z.boolean().optional(),
      recurrence: RecurrenceZ.nullable().optional().describe("With scope=series: new rule, or null to stop repeating"),
      account_id: AccountId,
    }),
    approval: "always",
    label: (i, ctx) => {
      const e = ctx.knownEvents.get(i.event_id);
      return `Updating “${truncate(e?.subject || "event", 36)}”`;
    },
    preview: (i, ctx) => {
      const e = ctx.knownEvents.get(i.event_id);
      const lines = [
        `${e?.subject ?? i.event_id}${i.scope === "series" ? " (whole series)" : e?.seriesMasterId ? " (this occurrence)" : ""}`,
        e ? `Currently: ${whenText(e.start, e.end, e.isAllDay)}` : "",
        i.start || i.end ? `New time: ${whenText(i.start ?? e?.start ?? "", i.end ?? e?.end ?? "", i.is_all_day ?? e?.isAllDay)}` : "",
        i.subject ? `New title: ${i.subject}` : "",
        i.location !== undefined ? `Where: ${i.location ?? "(cleared)"}` : "",
        i.attendees ? `Attendees: ${i.attendees.map((a) => a.email).join(", ")}` : "",
        i.recurrence !== undefined ? `Repeats: ${i.recurrence ? recurrenceText(i.recurrence as Recurrence) : "no longer"}` : "",
        i.show_as ? `Show as: ${i.show_as}` : "",
        i.body !== undefined ? `Notes: ${i.body ? truncate(i.body, 200) : "(cleared)"}` : "",
        e && e.response === "organizer" && e.attendees.length ? `${e.attendees.length} attendee${e.attendees.length === 1 ? "" : "s"} will receive an update` : "",
      ];
      return lines.filter(Boolean).join("\n");
    },
    async run(i, ctx) {
      const known = ctx.knownEvents.get(i.event_id);
      const accountId = known?.accountId ?? (await resolveAccount(i.account_id, ctx));
      if (i.start && i.end && i.end <= i.start) throw new Error("end must be after start");
      const patch: EventPatch = {};
      if (i.subject !== undefined) patch.subject = i.subject;
      if (i.start !== undefined) patch.start = sec(i.start);
      if (i.end !== undefined) patch.end = sec(i.end);
      if (i.is_all_day !== undefined) patch.isAllDay = i.is_all_day;
      if (i.location !== undefined) patch.location = i.location;
      if (i.body !== undefined) patch.body = i.body;
      if (i.attendees) patch.attendees = i.attendees.map((a) => ({ name: a.name ?? "", email: a.email }));
      if (i.optional_attendees) patch.optionalAttendees = i.optional_attendees.map((a) => ({ name: a.name ?? "", email: a.email }));
      if (i.attendees && !i.optional_attendees && known) patch.optionalAttendees = known.attendees.filter((a) => a.type === "optional").map((a) => a.addr);
      if (i.is_online !== undefined) patch.isOnline = i.is_online;
      if (i.show_as) patch.showAs = i.show_as;
      if (i.reminder_minutes !== undefined) patch.reminderMinutes = i.reminder_minutes < 0 ? null : i.reminder_minutes;
      if (i.is_private !== undefined) patch.sensitivity = i.is_private ? "private" : "normal";
      if (i.recurrence !== undefined) patch.recurrence = (i.recurrence as Recurrence | null) ?? null;
      const ev = await api.eventUpdate(accountId, i.event_id, patch, i.scope ?? "occurrence");
      ctx.knownEvents.set(ev.id, ev);
      ctx.ui({ kind: "open_event", id: ev.id });
      return { updated: compactEvent(ev) };
    },
  }),
  def({
    name: "delete_event",
    description: "Delete an event, or cancel a meeting the user organizes (attendees are notified, with an optional message). For recurring events choose this occurrence or the whole series. Always asks the user to confirm.",
    schema: z.object({
      event_id: z.string(),
      scope: Scope,
      comment: z.string().optional().describe("Message to attendees when cancelling a meeting the user organizes"),
      account_id: AccountId,
    }),
    approval: "always",
    label: (i, ctx) => {
      const e = ctx.knownEvents.get(i.event_id);
      const organizer = e?.response === "organizer" && (e?.attendees.length ?? 0) > 0;
      return `${organizer ? "Cancelling" : "Deleting"} “${truncate(e?.subject || "event", 36)}”`;
    },
    preview: (i, ctx) => {
      const e = ctx.knownEvents.get(i.event_id);
      const organizer = e?.response === "organizer" && (e?.attendees.length ?? 0) > 0;
      return [
        `${organizer ? "Cancel meeting" : "Delete"}: ${e?.subject ?? i.event_id}${i.scope === "series" ? " — whole series" : e?.seriesMasterId ? " — this occurrence only" : ""}`,
        e ? `When: ${whenText(e.start, e.end, e.isAllDay)}` : "",
        organizer ? `${e!.attendees.length} attendee${e!.attendees.length === 1 ? "" : "s"} will be notified` : "",
        i.comment ? `Message: ${i.comment}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    async run(i, ctx) {
      const known = ctx.knownEvents.get(i.event_id);
      const accountId = known?.accountId ?? (await resolveAccount(i.account_id, ctx));
      await api.eventDelete(accountId, i.event_id, i.scope ?? "occurrence", i.comment ?? null);
      ctx.knownEvents.delete(i.event_id);
      return "Done.";
    },
  }),
  def({
    name: "respond_to_invite",
    description: "Accept, tentatively accept or decline a calendar invitation (by event id from list_events). Always asks the user to confirm.",
    schema: z.object({
      event_id: z.string(),
      action: z.enum(["accept", "tentativelyAccept", "decline"]),
      comment: z.string().optional().describe("Optional note to the organizer"),
      send_response: z.boolean().optional().describe("Send the response to the organizer (default true)"),
      account_id: AccountId,
    }),
    approval: "always",
    label: (i, ctx) => {
      const e = ctx.knownEvents.get(i.event_id);
      const verb = i.action === "accept" ? "Accepting" : i.action === "decline" ? "Declining" : "Tentatively accepting";
      return e ? `${verb} “${truncate(e.subject || "(no title)", 32)}”` : `${verb} invitation`;
    },
    preview: (i, ctx) => {
      const e = ctx.knownEvents.get(i.event_id);
      const verb = i.action === "accept" ? "Accept" : i.action === "decline" ? "Decline" : "Tentatively accept";
      return [
        `${verb}: ${e ? e.subject || "(no title)" : i.event_id}`,
        e ? `When: ${whenText(e.start, e.end, e.isAllDay)}` : "",
        e?.organizer ? `Organizer: ${addr(e.organizer)}` : "",
        i.comment ? `Note: ${i.comment}` : "",
        i.send_response === false ? "No response will be sent to the organizer." : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    async run(i, ctx) {
      const known = ctx.knownEvents.get(i.event_id);
      const accountId = known?.accountId ?? (await resolveAccount(i.account_id, ctx));
      await api.inviteRespond(accountId, i.event_id, i.action, i.comment ?? null, i.send_response ?? true);
      if (known) ctx.knownEvents.set(known.id, { ...known, response: i.action === "accept" ? "accepted" : i.action === "decline" ? "declined" : "tentativelyAccepted" });
      return `${i.action === "accept" ? "Accepted" : i.action === "decline" ? "Declined" : "Tentatively accepted"}.`;
    },
  }),
];

export type AnyTool = (typeof TOOLS)[number];

export const TOOL_BY_NAME = new Map<string, ToolDef<z.ZodType>>(
  TOOLS.map((t) => [t.name, t as unknown as ToolDef<z.ZodType>]),
);

/** Provider-neutral specs (JSON Schema generated from zod; byte-stable across calls for caching). */
export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => {
  const schema = z.toJSONSchema(t.schema as z.ZodType, { io: "input", target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, jsonSchema: schema };
});

export type { ToolDef };
