// Streaming writing helpers: thread summary, reply drafting, rewriting, daily briefing.
import type { Account, MessageFull, MessageSummary } from "../types";
import type { Backend, Effort } from "./backend";
import { settings } from "./config";
import { AiError, friendlyError, isAbort } from "./errors";
import { emailBlock, nowLine, summaryBlock, threadBlock } from "./format";
import { BRIEFING_SYSTEM, DRAFT_SYSTEM, REWRITE_SYSTEM, SUMMARY_SYSTEM, aboutMeBlock } from "./prompts";
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

export function rewrite(text: string, instruction: string, signal?: AbortSignal): AsyncGenerator<string> {
  const user = `Instruction: ${instruction}\n\n<text>\n${text}\n</text>`;
  return run("main", REWRITE_SYSTEM, user, "low", 8000, signal);
}

export async function briefing(msgs: MessageSummary[], signal?: AbortSignal): Promise<string> {
  const lines = msgs.map((m, i) => {
    const ai = m.ai ? `\nAI triage: ${m.ai.category}, priority ${m.ai.priority}: ${m.ai.summary}` : "";
    return summaryBlock(m, `m${i + 1}`) + ai;
  });
  const user =
    aboutMeBlock(settings().ai.aboutMe) +
    `Now: ${nowLine()}\n\nInbox (${msgs.length} recent messages, newest first):\n\n${lines.join("\n\n")}`;
  let out = "";
  for await (const d of run("main", BRIEFING_SYSTEM, user, "low", 4000, signal)) out += d;
  return out;
}
