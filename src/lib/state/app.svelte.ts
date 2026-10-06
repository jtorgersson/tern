// Central application state (Svelte 5 runes, shared module).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "$lib/api";
import { applyTheme } from "$lib/theme";
import { configureAi, hasAi, resetBackends, triage } from "$lib/ai";
import {
  EVENTS,
  type Account,
  type AiCategory,
  type AuthProgressEvent,
  type Folder,
  type MailChangedEvent,
  type MessageFull,
  type MessageSummary,
  type MessageView,
  type Settings,
  type SyncStatusEvent,
  type Theme,
  type WellKnownFolder,
} from "$lib/types";
import { toasts } from "./toasts.svelte";
import { errMsg } from "$lib/util/misc";

export type UiView = MessageView | { kind: "results"; title: string; ids: string[] };

export const CATEGORY_META: Record<AiCategory, { label: string; color: string; short: string }> = {
  needs_reply: { label: "Needs reply", color: "var(--accent)", short: "Reply" },
  action: { label: "Action", color: "var(--orange)", short: "Action" },
  calendar: { label: "Calendar", color: "var(--blue)", short: "Calendar" },
  fyi: { label: "FYI", color: "var(--cyan)", short: "FYI" },
  newsletter: { label: "Newsletters", color: "var(--magenta)", short: "News" },
  notification: { label: "Notifications", color: "var(--muted)", short: "Notif" },
  receipt: { label: "Receipts", color: "var(--green)", short: "Receipt" },
  spam: { label: "Likely spam", color: "var(--red)", short: "Spam" },
};

export const SMART_CATEGORIES: AiCategory[] = [
  "needs_reply",
  "action",
  "calendar",
  "fyi",
  "newsletter",
  "notification",
  "receipt",
];

const PAGE = 60;

function viewKey(v: UiView): string {
  return JSON.stringify(v);
}

class AppState {
  // ---- boot ----
  ready = $state(false);
  bootError = $state<string | null>(null);

  // ---- data ----
  accounts = $state<Account[]>([]);
  settings = $state<Settings | null>(null);
  theme = $state<Theme | null>(null);
  folders = $state<Folder[]>([]);
  syncStatus = $state<Record<string, SyncStatusEvent>>({});
  authProgress = $state<AuthProgressEvent | null>(null);
  categoryCounts = $state<Partial<Record<AiCategory, number>>>({});

  // ---- list ----
  view = $state<UiView>({ kind: "today" });
  accountFilter = $state<string | null>(null);
  unreadOnly = $state(false);
  messages = $state<MessageSummary[]>([]);
  loading = $state(false);
  hasMore = $state(true);
  selectedId = $state<string | null>(null);
  checked = $state<Set<string>>(new Set());

  // ---- reader ----
  open = $state<MessageFull | null>(null);
  thread = $state<MessageFull[]>([]);
  openLoading = $state(false);

  // ---- overlays ----
  agentOpen = $state(false);
  paletteOpen = $state(false);
  settingsOpen = $state(false);
  settingsSection = $state<string>("accounts");
  cheatsheetOpen = $state(false);
  /** True while the first-run flow is on screen (survives the first account being added). */
  onboarding = $state(false);
  searchFocusTick = $state(0);

  // ---- ai ----
  triaging = $state(false);

  aiReady = $derived(this.settings ? hasAi(this.settings) : false);
  hasAccounts = $derived(this.accounts.length > 0);
  selectedIndex = $derived(this.messages.findIndex((m) => m.id === this.selectedId));
  accountById = $derived(new Map(this.accounts.map((a) => [a.id, a])));
  mode = $derived<"dark" | "light">(this.theme?.mode === "light" ? "light" : "dark");
  isUnifiedView = $derived(
    !this.accountFilter &&
      this.accounts.length > 1 &&
      this.view.kind !== "folder",
  );

  private unlisten: UnlistenFn[] = [];
  private loadSeq = 0;
  private triageTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  // ======================= boot =======================
  async init() {
    try {
      const boot = await api.bootstrap();
      this.accounts = boot.accounts;
      this.settings = boot.settings;
      this.theme = boot.theme;
      applyTheme(boot.theme, boot.settings.ui.translucent);
      configureAi(() => this.settings!);
      await this.listenAll();
      if (this.accounts.length) {
        // Today is the home screen when AI is set up; otherwise start in the inbox.
        if (!this.aiReady) this.view = { kind: "unified", wellKnown: "inbox" };
        await this.refreshFolders();
        await this.reload();
        this.refreshCounts();
        this.scheduleTriage(1500);
        const mailto = await invoke<string | null>("take_pending_mailto");
        if (mailto) this.openMailto(mailto);
      }
    } catch (e) {
      this.bootError = errMsg(e);
    } finally {
      this.ready = true;
    }
  }

  private async listenAll() {
    this.unlisten.push(
      await listen<Theme>(EVENTS.themeChanged, (e) => {
        this.theme = e.payload;
        applyTheme(e.payload, this.settings?.ui.translucent ?? false);
      }),
      await listen<SyncStatusEvent>(EVENTS.syncStatus, (e) => {
        this.syncStatus = { ...this.syncStatus, [e.payload.accountId]: e.payload };
        if (e.payload.state === "error" && e.payload.message) {
          const acct = this.accountById.get(e.payload.accountId);
          toasts.error(`${acct?.email ?? "Sync"}: ${e.payload.message}`);
        }
        if (e.payload.state === "reauth") {
          const acct = this.accountById.get(e.payload.accountId);
          toasts.show(`${acct?.email ?? "Account"} needs to sign in again`, {
            kind: "error",
            timeout: 0,
            action: { label: "Settings", run: () => this.openSettings("accounts") },
          });
        }
      }),
      await listen<MailChangedEvent>(EVENTS.mailChanged, (e) => {
        this.scheduleRefresh();
        if (e.payload.newMessageIds.length) this.scheduleTriage(800);
      }),
      await listen<AuthProgressEvent>(EVENTS.authProgress, (e) => {
        this.authProgress = e.payload;
      }),
      await listen<string>("app://mailto", (e) => this.openMailto(e.payload)),
      await listen(EVENTS.accountsChanged, async () => {
        this.accounts = await api.accounts();
        await this.refreshFolders();
      }),
    );
  }

  private async openMailto(url: string) {
    if (!this.accounts.length) return;
    const [{ composer }, { parseMailto }] = await Promise.all([
      import("./composer.svelte"),
      import("$lib/util/mailto"),
    ]);
    composer.compose(parseMailto(url));
  }

  destroy() {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
  }

  // ======================= settings =======================
  async saveSettings(next: Settings) {
    try {
      this.settings = await api.settingsSet(next);
      resetBackends();
      import("./today.svelte").then(({ today }) => {
        if (!this.settings?.ai.predraftReplies) today.cancelPredraft();
        else today.schedulePredraft();
      });
      if (this.theme) applyTheme(this.theme, this.settings.ui.translucent);
    } catch (e) {
      toasts.error(`Could not save settings: ${errMsg(e)}`);
      throw e;
    }
  }

  async patchSettings(fn: (s: Settings) => void) {
    if (!this.settings) return;
    const copy: Settings = $state.snapshot(this.settings) as Settings;
    fn(copy);
    await this.saveSettings(copy);
  }

  openSettings(section = "accounts") {
    this.settingsSection = section;
    this.settingsOpen = true;
  }

  // ======================= accounts =======================
  async addMicrosoftAccount(): Promise<Account | null> {
    this.authProgress = { state: "waiting_browser", message: null };
    try {
      const acct = await api.addMicrosoftAccount();
      this.accounts = await api.accounts();
      this.authProgress = { state: "done", message: null };
      toasts.show(`Signed in as ${acct.email}`, { kind: "success" });
      await this.refreshFolders();
      await this.reload();
      return acct;
    } catch (e) {
      const msg = errMsg(e);
      this.authProgress = { state: "error", message: msg };
      if (!/cancel/i.test(msg)) toasts.error(`Sign-in failed: ${msg}`);
      return null;
    }
  }

  async removeAccount(id: string) {
    await api.removeAccount(id);
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accountFilter === id) this.accountFilter = null;
    this.folders = this.folders.filter((f) => f.accountId !== id);
    await this.reload();
  }

  async updateAccount(id: string, patch: { displayName?: string; hue?: number }) {
    const updated = await api.updateAccount(id, patch);
    this.accounts = this.accounts.map((a) => (a.id === id ? updated : a));
  }

  // ======================= folders & counts =======================
  async refreshFolders() {
    try {
      this.folders = await api.folders(null);
    } catch (e) {
      console.error(e);
    }
  }

  folderFor(accountId: string, wk: WellKnownFolder): Folder | undefined {
    return this.folders.find((f) => f.accountId === accountId && f.wellKnown === wk);
  }

  unifiedUnread(wk: WellKnownFolder): number {
    return this.folders
      .filter((f) => f.wellKnown === wk && (!this.accountFilter || f.accountId === this.accountFilter))
      .reduce((n, f) => n + f.unread, 0);
  }

  async refreshCounts() {
    // Counts come from stored annotations, so they're shown even when AI is currently off.
    const entries = await Promise.all(
      SMART_CATEGORIES.map(async (c) => {
        try {
          const list = await api.messages({
            view: { kind: "category", category: c },
            accountId: this.accountFilter,
            unreadOnly: c !== "needs_reply" && c !== "action",
            limit: 500,
          });
          return [c, list.length] as const;
        } catch {
          return [c, 0] as const;
        }
      }),
    );
    this.categoryCounts = Object.fromEntries(entries);
  }

  // ======================= list =======================
  setView(v: UiView) {
    if (viewKey(v) === viewKey(this.view)) return;
    this.view = v;
    this.checked = new Set();
    this.reload();
  }

  setAccountFilter(id: string | null) {
    this.accountFilter = id;
    this.reload();
    this.refreshCounts();
  }

  toggleUnreadOnly() {
    this.unreadOnly = !this.unreadOnly;
    this.reload();
  }

  async reload(keepSelection = false) {
    const seq = ++this.loadSeq;
    this.loading = true;
    try {
      let list: MessageSummary[];
      if (this.view.kind === "today") {
        const { today } = await import("./today.svelte");
        await today.load();
        if (seq !== this.loadSeq) return;
        this.messages = [];
        this.hasMore = false;
        this.selectedId = null;
        if (!keepSelection) {
          this.open = null;
          this.thread = [];
        }
        return;
      }
      if (this.view.kind === "results") {
        const ids = this.view.ids;
        const fulls = await Promise.all(
          ids.map((id) => api.message(id).catch(() => null)),
        );
        list = fulls.filter((m): m is MessageFull => !!m);
        this.hasMore = false;
      } else {
        list = await api.messages({
          view: this.view,
          accountId: this.view.kind === "folder" ? null : this.accountFilter,
          unreadOnly: this.unreadOnly,
          limit: PAGE,
          before: null,
        });
        this.hasMore = list.length >= PAGE;
      }
      if (seq !== this.loadSeq) return;
      this.messages = list;
      if (!keepSelection || !list.some((m) => m.id === this.selectedId)) {
        this.selectedId = list[0]?.id ?? null;
        if (!keepSelection) {
          this.open = null;
          this.thread = [];
        }
      }
    } catch (e) {
      if (seq === this.loadSeq) toasts.error(errMsg(e));
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  async loadMore() {
    if (this.loading || !this.hasMore || this.view.kind === "results" || this.view.kind === "today") return;
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    this.loading = true;
    const seq = this.loadSeq;
    try {
      const more = await api.messages({
        view: this.view,
        accountId: this.view.kind === "folder" ? null : this.accountFilter,
        unreadOnly: this.unreadOnly,
        limit: PAGE,
        before: last.receivedAt,
      });
      if (seq !== this.loadSeq) return;
      const seen = new Set(this.messages.map((m) => m.id));
      this.messages = [...this.messages, ...more.filter((m) => !seen.has(m.id))];
      this.hasMore = more.length >= PAGE;
    } finally {
      this.loading = false;
    }
  }

  /** Background refresh after sync: merge without disturbing selection. */
  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      await Promise.all([this.refreshFolders(), this.reload(true)]);
      this.refreshCounts();
    }, 400);
  }

  search(query: string) {
    const q = query.trim();
    if (!q) {
      this.setView({ kind: "unified", wellKnown: "inbox" });
      return;
    }
    this.view = { kind: "search", query: q };
    this.reload();
  }

  showResults(title: string, ids: string[]) {
    this.view = { kind: "results", title, ids };
    this.reload();
  }

  viewTitle = $derived.by(() => {
    const v = this.view;
    switch (v.kind) {
      case "today":
        return "Today";
      case "unified":
        return v.wellKnown === "inbox"
          ? this.accountFilter
            ? "Inbox"
            : this.accounts.length > 1
              ? "All inboxes"
              : "Inbox"
          : wkLabel(v.wellKnown);
      case "flagged":
        return "Flagged";
      case "category":
        return CATEGORY_META[v.category].label;
      case "search":
        return `“${v.query}”`;
      case "results":
        return v.title;
      case "folder": {
        const f = this.folders.find((x) => x.id === v.folderId);
        return f?.name ?? "Folder";
      }
    }
  });

  // ======================= selection & reader =======================
  select(id: string | null, openIt = true) {
    if (id && this.view.kind === "today") {
      // Leave Today for the inbox so the reader has a list to sit next to.
      this.view = { kind: "unified", wellKnown: "inbox" };
      this.reload(true).then(() => (this.selectedId = id));
    }
    this.selectedId = id;
    if (id && openIt) this.openMessage(id);
  }

  move(delta: number) {
    if (!this.messages.length) return;
    const i = this.selectedIndex < 0 ? 0 : this.selectedIndex;
    const next = Math.max(0, Math.min(this.messages.length - 1, i + delta));
    this.select(this.messages[next].id);
    if (next >= this.messages.length - 8) this.loadMore();
  }

  toggleCheck(id: string) {
    const s = new Set(this.checked);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.checked = s;
  }

  /** Ids an action applies to: checked set, else the selection. */
  targetIds(): string[] {
    if (this.checked.size) return [...this.checked];
    return this.selectedId ? [this.selectedId] : [];
  }

  private openSeq = 0;
  async openMessage(id: string) {
    const seq = ++this.openSeq;
    this.openLoading = true;
    try {
      const msg = await api.message(id);
      if (seq !== this.openSeq) return;
      this.open = msg;
      this.thread = [msg];
      if (!msg.isRead) this.setRead([id], true, true);
      api
        .thread(id)
        .then((t) => {
          if (seq === this.openSeq && t.length) this.thread = t;
        })
        .catch(() => {});
    } catch (e) {
      if (seq === this.openSeq) toasts.error(`Could not open message: ${errMsg(e)}`);
    } finally {
      if (seq === this.openSeq) this.openLoading = false;
    }
  }

  closeReader() {
    this.open = null;
    this.thread = [];
  }

  // ======================= actions (optimistic) =======================
  private patchLocal(ids: string[], patch: Partial<MessageSummary>) {
    const set = new Set(ids);
    this.messages = this.messages.map((m) => (set.has(m.id) ? { ...m, ...patch } : m));
    if (this.open && set.has(this.open.id)) this.open = { ...this.open, ...patch };
  }

  async setRead(ids: string[], read: boolean, silent = false) {
    if (!ids.length) return;
    const unreadDelta = this.messages.filter((m) => ids.includes(m.id) && m.isRead !== read);
    this.patchLocal(ids, { isRead: read });
    // keep folder counters roughly right
    for (const m of unreadDelta) {
      this.folders = this.folders.map((f) =>
        f.id === m.folderId ? { ...f, unread: Math.max(0, f.unread + (read ? -1 : 1)) } : f,
      );
    }
    try {
      await api.setRead(ids, read);
    } catch (e) {
      this.patchLocal(ids, { isRead: !read });
      if (!silent) toasts.error(errMsg(e));
    }
  }

  async toggleRead(ids = this.targetIds()) {
    const first = this.messages.find((m) => m.id === ids[0]);
    if (first) await this.setRead(ids, !first.isRead);
  }

  async toggleFlag(ids = this.targetIds()) {
    const first = this.messages.find((m) => m.id === ids[0]) ?? this.open;
    if (!first) return;
    const flagged = !first.isFlagged;
    this.patchLocal(ids, { isFlagged: flagged });
    try {
      await api.setFlag(ids, flagged);
    } catch (e) {
      this.patchLocal(ids, { isFlagged: !flagged });
      toasts.error(errMsg(e));
    }
  }

  /** Remove from list, advance selection, return snapshot for undo. */
  private removeLocal(ids: string[]) {
    const set = new Set(ids);
    const removed = this.messages.filter((m) => set.has(m.id));
    const idx = this.selectedIndex;
    const remaining = this.messages.filter((m) => !set.has(m.id));
    this.messages = remaining;
    this.checked = new Set();
    if (this.selectedId && set.has(this.selectedId)) {
      const next = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
      this.selectedId = next?.id ?? null;
      if (this.open && set.has(this.open.id)) {
        if (next) this.openMessage(next.id);
        else this.closeReader();
      }
    }
    return removed;
  }

  async archive(ids = this.targetIds()) {
    await this.moveTo(ids, "archive", ids.length > 1 ? `Archived ${ids.length} messages` : "Archived");
  }

  async trash(ids = this.targetIds()) {
    await this.moveTo(ids, "deleteditems", ids.length > 1 ? `Deleted ${ids.length} messages` : "Deleted", true);
  }

  async moveTo(ids: string[], destination: string, label?: string, isDelete = false) {
    if (!ids.length) return;
    const removed = this.removeLocal(ids);
    try {
      if (isDelete) await api.remove(ids);
      else await api.move(ids, destination);
      toasts.show(label ?? "Moved", {
        kind: "success",
        timeout: 6000,
        action: {
          label: "Undo",
          run: async () => {
            // Move each message back to the folder it came from.
            const byFolder = new Map<string, string[]>();
            for (const m of removed) byFolder.set(m.folderId, [...(byFolder.get(m.folderId) ?? []), m.id]);
            try {
              for (const [folder, mids] of byFolder) await api.move(mids, folder);
            } catch (e) {
              toasts.error(`Undo failed: ${errMsg(e)}`);
            }
            this.scheduleRefresh();
          },
        },
      });
      this.refreshCounts();
    } catch (e) {
      toasts.error(errMsg(e));
      this.reload(true);
    }
  }

  async syncNow(accountId: string | null = null) {
    try {
      await api.syncNow(accountId);
    } catch (e) {
      toasts.error(errMsg(e));
    }
  }

  isSyncing = $derived(Object.values(this.syncStatus).some((s) => s.state === "syncing"));

  // ======================= triage =======================
  scheduleTriage(delay = 1000) {
    clearTimeout(this.triageTimer);
    this.triageTimer = setTimeout(() => this.runTriage(), delay);
  }

  async runTriage() {
    if (this.triaging || !this.settings?.ai.triageEnabled || !this.aiReady) return;
    this.triaging = true;
    try {
      for (let round = 0; round < 4; round++) {
        const pending = await api.untriaged(25);
        if (!pending.length) break;
        const notes = await triage(pending);
        if (!notes.length) break;
        await api.annotationsSet(notes);
        const byId = new Map(notes.map((n) => [n.messageId, n]));
        this.messages = this.messages.map((m) => (byId.has(m.id) ? { ...m, ai: byId.get(m.id)! } : m));
        if (pending.length < 25) break;
      }
      this.refreshCounts();
      const { today } = await import("./today.svelte");
      if (this.view.kind === "today") today.load({ silent: true });
      else today.schedulePredraft();
    } catch (e) {
      console.warn("triage failed", e);
      toasts.show(`AI triage paused: ${errMsg(e)}`, { kind: "error", timeout: 6000 });
    } finally {
      this.triaging = false;
    }
  }

  // ======================= overlays =======================
  toggleAgent(open?: boolean) {
    this.agentOpen = open ?? !this.agentOpen;
  }
}

export function wkLabel(wk: WellKnownFolder): string {
  return (
    {
      inbox: "Inbox",
      sentitems: "Sent",
      drafts: "Drafts",
      archive: "Archive",
      deleteditems: "Trash",
      junkemail: "Junk",
      outbox: "Outbox",
    } as const
  )[wk];
}

export const app = new AppState();
