// Batch inbox triage with structured output.
import * as z from "zod";
import { api } from "../api";
import type { AiCategory, Annotation, MessageSummary } from "../types";
import { settings } from "./config";
import { AiError, friendlyError } from "./errors";
import { nowLine, summaryBlock, truncate } from "./format";
import { TRIAGE_SYSTEM, aboutMeBlock } from "./prompts";
import { backend } from "./providers";

const BATCH = 25;

const CATEGORIES = [
  "needs_reply", "action", "fyi", "calendar", "newsletter", "notification", "receipt", "spam",
] as const satisfies readonly AiCategory[];

const TriageOut = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      category: z.enum(CATEGORIES),
      priority: z.number().int(),
      summary: z.string(),
      actionItems: z.array(z.string()),
      needsReply: z.boolean(),
      dueAt: z.string().nullable(),
    }),
  ),
});

/** Classify messages. Returns one Annotation per message the model handled (does not persist). */
export async function triage(msgs: MessageSummary[], signal?: AbortSignal): Promise<Annotation[]> {
  if (!msgs.length) return [];
  const b = await backend("fast");
  const out: Annotation[] = [];
  for (let i = 0; i < msgs.length; i += BATCH) {
    const chunk = msgs.slice(i, i + BATCH);
    const keyed = new Map(chunk.map((m, j) => [`m${j + 1}`, m]));
    const user =
      aboutMeBlock(settings().ai.aboutMe) +
      `Now: ${nowLine()}\n\nTriage these ${chunk.length} emails:\n\n` +
      [...keyed].map(([k, m]) => summaryBlock(m, k)).join("\n\n");
    let res: z.infer<typeof TriageOut>;
    try {
      res = await b.structured({ system: TRIAGE_SYSTEM, user, schema: TriageOut, name: "triage", effort: "low", maxTokens: 8000, signal });
    } catch (err) {
      throw err instanceof AiError ? err : new AiError(friendlyError(err, b.provider));
    }
    for (const it of res.items) {
      const m = keyed.get(it.key);
      if (!m) continue;
      out.push({
        messageId: m.id,
        category: it.category,
        priority: Math.min(3, Math.max(1, Math.round(it.priority))) as 1 | 2 | 3,
        summary: truncate(it.summary.trim(), 140),
        actionItems: it.actionItems.map((a) => a.trim()).filter(Boolean).slice(0, 5),
        needsReply: it.needsReply,
        dueAt: it.dueAt && !Number.isNaN(Date.parse(it.dueAt)) ? it.dueAt : null,
        suggestedReply: null,
      });
    }
  }
  return out;
}

/** Fetch untriaged inbox mail, triage it, persist the annotations, and return them. */
export async function triageInbox(limit = 50, signal?: AbortSignal): Promise<Annotation[]> {
  if (!settings().ai.triageEnabled) return [];
  const msgs = await api.untriaged(limit);
  const anns = await triage(msgs, signal);
  if (anns.length) await api.annotationsSet(anns);
  return anns;
}
