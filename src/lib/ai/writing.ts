// Streaming writing helpers: thread summary, reply drafting, rewriting, daily briefing.
import type { Account, CalEvent, MessageFull, MessageSummary } from "../types";
import type { Backend, Effort } from "./backend";
import { settings } from "./config";
import { AiError, friendlyError, isAbort } from "./errors";
import { emailBlock, nowLine, sentBlock, summaryBlock, threadBlock } from "./format";
import { BRIEFING_SYSTEM, DRAFT_SYSTEM, PREP_SYSTEM, REWRITE_SYSTEM, SUMMARY_SYSTEM, aboutMeBlock } from "./prompts";
import { backend } from "./providers";

async function* run(
  purpose: "main" | "fast",
  system: string,
  user: string,
  effort: Effort,
  maxTokens: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  let b: Backend | undefined;
  try {
    b = await backend(purpose);
    yield* b.streamText({ system, user, effort, maxTokens, signal });
  } catch (err) {
    if (isAbort(err) || err instanceof AiError) throw err;
    throw new AiError(friendlyError(err, b?.provider));
  }
}

export function summarizeThread(thread: MessageFull[], signal?: AbortSignal): AsyncGenerator<string> {
  const user = aboutMeBlock(settings().ai.aboutMe) + `Summarize this thread (${thread.length} message(s), oldest first):\n\n${threadBlock(thread)}`;
  return run("main", SUMMARY_SYSTEM, user, "low", 4000, signal);
}

export function draftReply(opts: {
  message: MessageFull;
  thread?: MessageFull[];
  instruction: string;
  account: Account;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const { message, thread, instruction, account } = opts;
  const context = thread && thread.length > 1 ? threadBlock(thread) : emailBlock(message);
  const user =
    aboutMeBlock(settings().ai.aboutMe) +
    `You are writing as ${account.displayName} <${account.email}>. Now: ${nowLine()}\n\n` +
    `${context}\n\nWrite a reply to the email with id="${message.id}".\n` +
    `Instruction from the user: ${instruction.trim() || "Write an appropriate, helpful reply."}`;
  return run("main", DRAFT_SYSTEM, user, "medium", 8000, opts.signal);
}

/** Meeting prep brief from the event and the related mail found locally. */
export function prepMeeting(ev: CalEvent, related: MessageFull[], signal?: AbortSignal): AsyncGenerator<string> {
  const who = ev.attendees.map((a) => `${a.addr.name || a.addr.email} <${a.addr.email}> (${a.type}, ${a.response})`).join("; ");
  const event = [
    `<event>`,
    `Subject: ${ev.subject}`,
    `When: ${ev.start} – ${ev.end}${ev.isAllDay ? " (all day)" : ""}`,
    ev.location ? `Where: ${ev.location}` : "",
    ev.isOnline ? "Online: Teams" : "",
    ev.organizer ? `Organizer: ${ev.organizer.name || ev.organizer.email} <${ev.organizer.email}>` : "",
    who ? `Attendees: ${who}` : "",
    `My response: ${ev.response}`,
    ev.preview ? `Description: ${ev.preview}` : "",
    `</event>`,
  ]
    .filter(Boolean)
    .join("\n");
  const mail = related.length ? related.map((m) => emailBlock(m, 3000)).join("\n\n") : "(no related emails found)";
  const user = aboutMeBlock(settings().ai.aboutMe) + `Now: ${nowLine()}\n\n${event}\n\nRelated emails (newest first):\n\n${mail}`;
  return run("main", PREP_SYSTEM, user, "low", 2500, signal);
}

export function rewrite(text: string, instruction: string, signal?: AbortSignal): AsyncGenerator<string> {
  const user = `Instruction: ${instruction}\n\n<text>\n${text}\n</text>`;
  return run("main", REWRITE_SYSTEM, user, "low", 8000, signal);
}

export interface BriefingInput {
  inbox: MessageSummary[];
  /** Sent mail with no reply yet. */
  waiting: MessageSummary[];
  /** Inbox mail with a triage deadline. */
  due: MessageSummary[];
  /** Today's and tomorrow's calendar events (optional). */
  events?: CalEvent[];
}

function eventLine(e: CalEvent): string {
  const when = e.isAllDay ? `${e.start.slice(0, 10)} all day` : `${e.start.slice(0, 16).replace("T", " ")}–${e.end.slice(11, 16)}`;
  const flags = [
    e.isCancelled ? "cancelled" : "",
    e.response === "notResponded" ? "NOT RESPONDED" : e.response === "tentativelyAccepted" ? "tentative" : e.response === "declined" ? "declined" : "",
    e.isOnline ? "online" : "",
  ].filter(Boolean);
  const who = e.organizer ? ` (organizer ${e.organizer.name || e.organizer.email})` : "";
  return `- ${when} — ${e.subject || "(no title)"}${who}${e.location ? ` @ ${e.location}` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

function describe(m: MessageSummary, key: string): string {
  const ai = m.ai
    ? `\nAI triage: ${m.ai.category}, priority ${m.ai.priority}${m.ai.dueAt ? `, due ${m.ai.dueAt}` : ""}: ${m.ai.summary}`
    : "";
  return summaryBlock(m, key) + (m.isRead ? "\n(read)" : "\n(unread)") + ai;
}

/** Streams the Markdown briefing for the Today view. */
export function briefing(input: BriefingInput, signal?: AbortSignal): AsyncGenerator<string> {
  const parts: string[] = [aboutMeBlock(settings().ai.aboutMe) + `Now: ${nowLine()}`];
  parts.push(
    `Inbox (${input.inbox.length} recent messages, newest first):\n\n` +
      (input.inbox.map((m, i) => describe(m, `m${i + 1}`)).join("\n\n") || "(empty)"),
  );
  if (input.waiting.length) {
    parts.push(
      `Mail the user sent that has not been answered yet (${input.waiting.length}):\n\n` +
        input.waiting.map((m, i) => sentBlock(m, `sent${i + 1}`)).join("\n\n"),
    );
  }
  if (input.events?.length) {
    parts.push(`Calendar for today and tomorrow (${input.events.length} events, local time):\n` + input.events.map(eventLine).join("\n"));
  }
  if (input.due.length) {
    parts.push(
      `Items with deadlines:\n` +
        input.due.map((m) => `- ${m.ai?.dueAt ?? "?"} — ${m.from.name || m.from.email}: ${m.ai?.summary ?? m.subject}`).join("\n"),
    );
  }
  return run("main", BRIEFING_SYSTEM, parts.join("\n\n"), "low", 4000, signal);
}

/** Non-streaming reply draft used by the pre-drafting pipeline and the Today cards. */
export async function predraftReply(opts: {
  message: MessageFull;
  thread?: MessageFull[];
  account: Account;
  instruction?: string;
  signal?: AbortSignal;
}): Promise<string> {
  let out = "";
  for await (const d of draftReply({
    message: opts.message,
    thread: opts.thread,
    account: opts.account,
    instruction: opts.instruction ?? PREDRAFT_INSTRUCTION,
    signal: opts.signal,
  }))
    out += d;
  return out.trim();
}

export const PREDRAFT_INSTRUCTION =
  "Write the reply you think the user would most likely want to send. If a decision is required that you can't know, draft the warm, non-committal version and leave a [bracketed placeholder] for the decision.";
