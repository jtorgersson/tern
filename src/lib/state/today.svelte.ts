// Today view state: briefing, needs-reply cards, follow-ups, deadlines, and the pre-drafting pipeline.
import { api } from "$lib/api";
import { briefing, predraftReply } from "$lib/ai";
import type { MessageFull, MessageSummary } from "$lib/types";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";
import { errMsg } from "$lib/util/misc";

const BRIEFING_MAX_AGE = 2 * 3600_000;
const BRIEFING_NEW_MAIL_TRIGGER = 5;
const DISMISS_KEY = "tern.today.dismissed";
const PREDRAFT_PER_RUN = 6;

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

class TodayState {
  // ---- data ----
  needsReply = $state<MessageSummary[]>([]);
  waiting = $state<MessageSummary[]>([]);
  due = $state<MessageSummary[]>([]);
  inbox = $state<MessageSummary[]>([]);
  loading = $state(false);
  loadedOnce = $state(false);

  // ---- briefing ----
  briefingText = $state("");
  briefingBusy = $state(false);
  briefingError = $state<string | null>(null);
  briefingAt = $state<number | null>(null);
  private briefingCtrl: AbortController | null = null;
  private newSinceBriefing = 0;
  private seenIds = new Set<string>();

  // ---- pre-drafting ----
  drafting = $state<Set<string>>(new Set());
  predraftRunning = $state(false);
  private predraftCtrl: AbortController | null = null;

  dismissed = $state<Set<string>>(loadDismissed());

  visibleWaiting = $derived(this.waiting.filter((m) => !this.dismissed.has(m.id)));
  unreadCount = $derived(this.inbox.filter((m) => !m.isRead).length);
  overdue = $derived(this.due.filter((m) => m.ai?.dueAt && new Date(m.ai.dueAt).getTime() < startOfToday()));
  dueToday = $derived(
    this.due.filter((m) => {
      const t = m.ai?.dueAt ? new Date(m.ai.dueAt).getTime() : NaN;
      return t >= startOfToday() && t < startOfToday() + 86_400_000;
    }),
  );
  dueWeek = $derived(
    this.due.filter((m) => {
      const t = m.ai?.dueAt ? new Date(m.ai.dueAt).getTime() : NaN;
      return t >= startOfToday() + 86_400_000;
    }),
  );
  /** Everything handled: nothing to reply, nobody to nudge, nothing due. */
  calm = $derived(this.loadedOnce && !this.needsReply.length && !this.visibleWaiting.length && !this.due.length);

  private loadSeq = 0;

  async load(opts: { silent?: boolean } = {}) {
    const seq = ++this.loadSeq;
    if (!opts.silent) this.loading = true;
    try {
      const [inbox, needs, waiting, due] = await Promise.all([
        api.messages({ view: { kind: "unified", wellKnown: "inbox" }, accountId: app.accountFilter, limit: 60 }),
        api.messages({ view: { kind: "category", category: "needs_reply" }, accountId: app.accountFilter, limit: 40 }),
        api.followups(14, 30).catch(() => [] as MessageSummary[]),
        api.due(20).catch(() => [] as MessageSummary[]),
      ]);
      if (seq !== this.loadSeq) return;
      this.inbox = inbox;
      this.needsReply = needs
        .filter((m) => m.ai)
        .sort((a, b) => Number(a.isRead) - Number(b.isRead) || (b.ai!.priority - a.ai!.priority) || b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, 8);
      this.waiting = waiting.filter((m) => !app.accountFilter || m.accountId === app.accountFilter);
      this.due = due.filter((m) => !app.accountFilter || m.accountId === app.accountFilter);

      // Count mail that arrived since the last briefing.
      let fresh = 0;
      for (const m of inbox) if (!this.seenIds.has(m.id)) { this.seenIds.add(m.id); fresh++; }
      if (this.briefingAt) this.newSinceBriefing += fresh;

      this.loadedOnce = true;
      this.maybeRefreshBriefing();
      this.schedulePredraft();
    } catch (e) {
      if (seq === this.loadSeq) toasts.error(errMsg(e));
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  // ======================= briefing =======================
  private maybeRefreshBriefing() {
    if (!app.aiReady || this.briefingBusy) return;
    const stale = !this.briefingAt || Date.now() - this.briefingAt > BRIEFING_MAX_AGE;
    if (stale || this.newSinceBriefing >= BRIEFING_NEW_MAIL_TRIGGER) this.refreshBriefing();
  }

  async refreshBriefing() {
    if (!app.aiReady) return;
    this.briefingCtrl?.abort();
    const ctrl = new AbortController();
    this.briefingCtrl = ctrl;
    this.briefingBusy = true;
    this.briefingError = null;
    const prev = this.briefingText;
    let acc = "";
    try {
      for await (const d of briefing({ inbox: this.inbox, waiting: this.visibleWaiting, due: this.due }, ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        acc += d;
        this.briefingText = acc;
      }
      if (!ctrl.signal.aborted) {
        this.briefingAt = Date.now();
        this.newSinceBriefing = 0;
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        this.briefingError = errMsg(e);
        if (!acc) this.briefingText = prev;
      }
    } finally {
      if (this.briefingCtrl === ctrl) {
        this.briefingBusy = false;
        this.briefingCtrl = null;
      }
    }
  }

  // ======================= pre-drafting =======================
  /** Called after triage and after load; runs at most one pass at a time. */
  schedulePredraft() {
    if (!app.settings?.ai.predraftReplies || !app.aiReady || this.predraftRunning) return;
    const candidates = this.needsReply.filter((m) => m.ai && m.ai.priority >= 2 && !m.ai.suggestedReply);
    if (!candidates.length) return;
    this.runPredraft(candidates.slice(0, PREDRAFT_PER_RUN));
  }

  cancelPredraft() {
    this.predraftCtrl?.abort();
  }

  private async runPredraft(list: MessageSummary[]) {
    const ctrl = new AbortController();
    this.predraftCtrl = ctrl;
    this.predraftRunning = true;
    try {
      for (const m of list) {
        if (ctrl.signal.aborted || !app.settings?.ai.predraftReplies) break;
        await this.draftFor(m.id, undefined, ctrl.signal);
        // Yield so the UI never feels the pipeline.
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      if (this.predraftCtrl === ctrl) {
        this.predraftRunning = false;
        this.predraftCtrl = null;
      }
    }
  }

  /** Draft (or redraft with an instruction) a reply for one message and persist it. Returns the text. */
  async draftFor(id: string, instruction?: string, signal?: AbortSignal): Promise<string | null> {
    const acct = this.needsReply.find((m) => m.id === id)?.accountId ?? app.open?.accountId;
    const account = acct ? app.accountById.get(acct) : undefined;
    if (!account) return null;
    this.drafting = new Set([...this.drafting, id]);
    try {
      const thread = await api.thread(id);
      const message = thread.find((t) => t.id === id) ?? thread[thread.length - 1];
      if (!message) return null;
      const text = await predraftReply({ message, thread, account, instruction, signal });
      if (signal?.aborted) return null;
      await api.annotationSetReply(id, text);
      this.applyReply(id, text);
      return text;
    } catch (e) {
      if (!signal?.aborted && instruction) toasts.error(`Could not draft: ${errMsg(e)}`);
      else if (!signal?.aborted) console.warn("predraft failed", e);
      return null;
    } finally {
      const s = new Set(this.drafting);
      s.delete(id);
      this.drafting = s;
    }
  }

  /** Clear the stored draft (e.g. after the user replied). */
  async clearReply(id: string) {
    this.applyReply(id, null);
    await api.annotationSetReply(id, null).catch(() => {});
  }

  private applyReply(id: string, text: string | null) {
    const patch = (m: MessageSummary) => (m.id === id && m.ai ? { ...m, ai: { ...m.ai, suggestedReply: text } } : m);
    this.needsReply = this.needsReply.map(patch);
    this.inbox = this.inbox.map(patch);
    app.messages = app.messages.map(patch);
    if (app.open?.id === id && app.open.ai) app.open = { ...app.open, ai: { ...app.open.ai, suggestedReply: text } } as MessageFull;
  }

  dismiss(id: string) {
    const s = new Set(this.dismissed);
    s.add(id);
    this.dismissed = s;
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify([...s]));
    } catch {}
  }
}

function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export const today = new TodayState();
