// Calendar store: events for any date range (synced window + on-demand fetches), the user's calendars,
// the current view/period, selection, invitations, and create / edit / move / delete.
import { api } from "$lib/api";
import type { CalEvent, CalView, Calendar, EditScope, EventDraft, EventFull, EventPatch, InviteAction, InviteInfo } from "$lib/types";
import {
  addDays,
  addMonths,
  dayKey,
  eventsOnDay,
  isBusy,
  monthGrid,
  overlaps,
  sortEvents,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toLocalIso,
  weekDays,
} from "$lib/util/cal";
import { dayMonth, dayMonthYear, isoWeek, monthLong, monthYear, weekdayDayMonthLong, word } from "$lib/util/fmt";
import { parseQuickAdd } from "$lib/util/quickadd";
import type { RepeatPreset } from "$lib/util/cal";

/** What the composer opens with: an EventDraft subset plus a repeat preset (turned into a recurrence on save). */
export type ComposerDraft = Partial<EventDraft> & { repeat?: RepeatPreset };
import { hueColor } from "$lib/theme";
import { errMsg } from "$lib/util/misc";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";
import { hhmm, weekdayDayMonth } from "$lib/util/fmt";

/** Keyboard time cursor on the day/week grid. */
export interface Cursor {
  /** Index into `days`. */
  col: number;
  /** Minutes from midnight (snapped to 30). */
  mins: number;
  /** Length in minutes. */
  len: number;
}

/** Must match src-tauri/src/calendar.rs. Inside this window the periodic sync keeps the cache fresh. */
const WINDOW_BACK_DAYS = 14;
const WINDOW_AHEAD_DAYS = 45;
/** Months fetched on demand are re-fetched when older than this. */
const COVERAGE_TTL = 10 * 60_000;
const VIEW_KEY = "tern.calView";
const VIEWS: CalView[] = ["day", "week", "month", "agenda"];

export interface Period {
  from: Date;
  /** Exclusive. */
  to: Date;
}

class CalendarState {
  /** Every event loaded this session (sync window + visited ranges). */
  events = $state<CalEvent[]>([]);
  calendars = $state<Calendar[]>([]);
  loading = $state(false);
  loadedOnce = $state(false);
  /** True while a range outside the sync window is being downloaded. */
  fetching = $state(false);
  /** Ticks every 30s so "now" markers and "in 25 min" labels move. */
  now = $state(new Date());

  /** Current view and the date it is anchored on. */
  view = $state<CalView>("week");
  anchor = $state<Date>(startOfDay(new Date()));

  /** Selection / details popover / composer. */
  selectedId = $state<string | null>(null);
  detailsId = $state<string | null>(null);
  /** Full body + recurrence for the open details popover (fetched live). */
  detailsFull = $state<EventFull | null>(null);
  composerOpen = $state(false);
  composerDraft = $state<ComposerDraft | null>(null);
  /** When editing an existing event. */
  composerEditing = $state<CalEvent | null>(null);
  composerScope = $state<EditScope>("occurrence");
  /** Bumped by the `#` shortcut: the details popover opens with its delete confirmation showing. */
  deleteRequest = $state(0);
  /** Event search (rail). */
  searchQuery = $state("");
  searchResults = $state<CalEvent[]>([]);
  searching = $state(false);
  searchFocusTick = $state(0);
  /** Keyboard time cursor (day/week views). */
  cursor = $state<Cursor | null>(null);

  /** Invitation details cached per message id. */
  invites = $state<Record<string, InviteInfo | null>>({});
  inviteLoading = $state<Set<string>>(new Set());

  private seq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** "YYYY-MM" → time an on-demand fetch of that month finished (or started, while pending). */
  private coverage = new Map<string, number>();
  private pending = new Set<string>();
  private viewInitialised = false;

  constructor() {
    if (typeof window !== "undefined") {
      this.timer = setInterval(() => (this.now = new Date()), 30_000);
      try {
        const v = localStorage.getItem(VIEW_KEY) as CalView | null;
        if (v && VIEWS.includes(v)) {
          this.view = v;
          this.viewInitialised = true;
        }
      } catch {}
    }
  }

  // ---------- derived ----------
  private settings = $derived(app.settings?.calendar);
  showWeekends = $derived(this.settings?.showWeekends ?? true);
  showWeekNumbers = $derived(this.settings?.showWeekNumbers ?? true);
  hidden = $derived(new Set(this.settings?.hiddenCalendars ?? []));
  calendarById = $derived(new Map(this.calendars.map((c) => [c.id, c])));
  /** Calendars of the active account filter. */
  visibleCalendars = $derived(this.calendars.filter((c) => !app.accountFilter || c.accountId === app.accountFilter));

  /** Date span of the current view. */
  period = $derived.by<Period>(() => {
    const a = startOfDay(this.anchor);
    switch (this.view) {
      case "day":
        return { from: a, to: addDays(a, 1) };
      case "week": {
        const from = startOfWeek(a);
        return { from, to: addDays(from, 7) };
      }
      case "month": {
        const g = monthGrid(a);
        return { from: g[0], to: addDays(g[41], 1) };
      }
      case "agenda":
        return { from: a, to: addDays(a, 14) };
    }
  });

  /** Days shown as columns / rows (month view uses monthGrid directly). */
  days = $derived.by<Date[]>(() => {
    switch (this.view) {
      case "day":
        return [startOfDay(this.anchor)];
      case "week":
        return weekDays(this.anchor, this.showWeekends);
      case "month":
        return monthGrid(this.anchor);
      case "agenda":
        return Array.from({ length: 14 }, (_, i) => addDays(startOfDay(this.anchor), i));
    }
  });

  title = $derived.by(() => {
    const a = this.anchor;
    switch (this.view) {
      case "day":
        return weekdayDayMonthLong(a) + (a.getFullYear() !== this.now.getFullYear() ? ` ${a.getFullYear()}` : "");
      case "week": {
        const { from, to } = this.period;
        const last = addDays(to, -1);
        if (from.getMonth() === last.getMonth()) return monthYear(from);
        if (from.getFullYear() === last.getFullYear()) return `${cap(monthLong(from))} – ${monthYear(last)}`;
        return `${monthYear(from)} – ${monthYear(last)}`;
      }
      case "month":
        return monthYear(a);
      case "agenda": {
        const { from, to } = this.period;
        return `${dayMonth(from)} – ${dayMonthYear(addDays(to, -1))}`;
      }
    }
  });

  /** "wk 41" / "wk 41–42" for the toolbar. */
  weekLabel = $derived.by(() => {
    if (this.view === "month") return "";
    const { from, to } = this.period;
    const w1 = isoWeek(from);
    const w2 = isoWeek(addDays(to, -1));
    return `${word("week")} ${w1 === w2 ? w1 : `${w1}–${w2}`}`;
  });

  /** Events for the active account filter and visible calendars. */
  visible = $derived(
    this.events.filter((e) => (!app.accountFilter || e.accountId === app.accountFilter) && !this.hidden.has(e.calendarId)),
  );
  /** Visible events intersecting the current period, sorted. */
  inPeriod = $derived.by(() => {
    const s = toLocalIso(this.period.from);
    const e = toLocalIso(this.period.to);
    return sortEvents(this.visible.filter((ev) => ev.start < e && ev.end > s));
  });
  todayEvents = $derived(eventsOnDay(this.visible, this.now));
  tomorrowEvents = $derived(eventsOnDay(this.visible, addDays(startOfDay(this.now), 1)));
  /** Timed meetings today that still count (not declined/cancelled). */
  todayMeetings = $derived(this.todayEvents.filter((e) => !e.isAllDay && isBusy(e)));
  nextUp = $derived.by(() => {
    const t = toLocalIso(this.now);
    return this.todayEvents.find((e) => !e.isAllDay && isBusy(e) && e.end > t) ?? null;
  });
  unanswered = $derived(this.visible.filter((e) => e.response === "notResponded" && !e.isCancelled && e.end > toLocalIso(this.now)));
  selected = $derived(this.events.find((e) => e.id === this.selectedId) ?? null);
  details = $derived(this.events.find((e) => e.id === this.detailsId) ?? null);
  isTodayVisible = $derived(this.period.from <= this.now && this.now < this.period.to);

  /** Colour of an event: its calendar's colour, else the account hue. */
  colorOf(ev: Pick<CalEvent, "calendarId" | "accountId">): string {
    const c = this.calendarById.get(ev.calendarId)?.color;
    if (c && !this.calendarById.get(ev.calendarId)?.isDefault) return c;
    const acct = app.accountById.get(ev.accountId);
    return acct ? hueColor(acct.hue, app.mode) : c || "var(--accent)";
  }

  eventsOn(day: Date): CalEvent[] {
    return eventsOnDay(this.visible, day);
  }

  byDay(days: Date[] = this.days): { day: Date; events: CalEvent[] }[] {
    return days.map((day) => ({ day, events: this.eventsOn(day) }));
  }

  /** Other busy events on the same account that overlap. */
  conflictsFor(ev: CalEvent): CalEvent[] {
    if (ev.isAllDay) return [];
    return this.events.filter(
      (o) => o.id !== ev.id && o.accountId === ev.accountId && !o.isAllDay && isBusy(o) && overlaps(o, ev) && (!o.seriesMasterId || o.seriesMasterId !== ev.seriesMasterId),
    );
  }

  /** Ids of timed events on a day that overlap at least one other busy event. */
  overlapIds(dayEvents: CalEvent[]): Set<string> {
    const out = new Set<string>();
    const timed = dayEvents.filter((e) => !e.isAllDay && isBusy(e));
    for (let i = 0; i < timed.length; i++)
      for (let j = i + 1; j < timed.length; j++)
        if (overlaps(timed[i], timed[j])) {
          out.add(timed[i].id);
          out.add(timed[j].id);
        }
    return out;
  }

  // ---------- navigation ----------
  setView(v: CalView) {
    if (!VIEWS.includes(v)) return;
    this.view = v;
    this.cursor = null;
    this.viewInitialised = true;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
    this.ensurePeriod();
  }

  /** Applies the settings default view once, if the user never picked one. */
  applyDefaultView() {
    if (!this.viewInitialised && this.settings?.defaultView && VIEWS.includes(this.settings.defaultView)) this.view = this.settings.defaultView;
    this.viewInitialised = true;
  }

  goto(date: Date, view?: CalView) {
    this.anchor = startOfDay(date);
    if (view) this.setView(view);
    else this.ensurePeriod();
  }

  today() {
    this.goto(this.now);
  }

  shift(delta: number) {
    const a = this.anchor;
    switch (this.view) {
      case "day":
        this.anchor = addDays(a, delta);
        break;
      case "week":
        this.anchor = addDays(a, 7 * delta);
        break;
      case "month":
        this.anchor = startOfMonth(addMonths(startOfMonth(a), delta));
        break;
      case "agenda":
        this.anchor = addDays(a, 14 * delta);
        break;
    }
    this.ensurePeriod();
  }
  next() {
    this.shift(1);
  }
  prev() {
    this.shift(-1);
  }

  // ---------- loading ----------
  private syncWindow(): Period {
    const base = startOfDay(this.now);
    return { from: addDays(base, -WINDOW_BACK_DAYS), to: addDays(base, WINDOW_AHEAD_DAYS) };
  }

  /** Replaces the in-memory events overlapping [from, to) with `list`. */
  private merge(list: CalEvent[], from: string, to: string) {
    const ids = new Set(list.map((e) => e.id));
    const keep = this.events.filter((e) => !ids.has(e.id) && !(e.start < to && e.end > from));
    this.events = sortEvents([...keep, ...list]);
  }

  /** Loads the sync window plus the current period from the cache. */
  async load(opts: { silent?: boolean } = {}) {
    const seq = ++this.seq;
    if (!opts.silent) this.loading = true;
    try {
      const w = this.syncWindow();
      const from = toLocalIso(new Date(Math.min(w.from.getTime(), this.period.from.getTime())));
      const to = toLocalIso(new Date(Math.max(w.to.getTime(), this.period.to.getTime())));
      const [list, cals] = await Promise.all([api.calendarEvents(from, to, null), this.calendars.length ? null : api.calendars(null)]);
      if (seq !== this.seq) return;
      this.merge(list, from, to);
      if (cals) this.calendars = cals;
      this.loadedOnce = true;
      this.ensurePeriod();
    } catch (e) {
      if (seq === this.seq && !opts.silent) toasts.error(`Calendar: ${errMsg(e)}`);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
  }

  async loadCalendars() {
    try {
      this.calendars = await api.calendars(null);
    } catch (e) {
      console.warn("calendar_list failed", e);
    }
  }

  /** Makes sure every month touched by the current period is in the cache (fetching from Graph when outside the sync window). */
  ensurePeriod() {
    if (!this.loadedOnce) return;
    const w = this.syncWindow();
    const { from, to } = this.period;
    const months: Date[] = [];
    for (let m = startOfMonth(from); m < to; m = addMonths(m, 1)) months.push(m);
    for (const m of months) {
      const mFrom = m;
      const mTo = addMonths(m, 1);
      // Fully inside the sync window → the periodic sync owns it.
      if (mFrom >= w.from && mTo <= w.to) continue;
      const key = dayKey(m).slice(0, 7);
      const at = this.coverage.get(key);
      if (this.pending.has(key) || (at && Date.now() - at < COVERAGE_TTL)) continue;
      this.fetchMonth(key, mFrom, mTo);
    }
  }

  private async fetchMonth(key: string, from: Date, to: Date) {
    this.pending.add(key);
    this.fetching = true;
    const f = toLocalIso(from);
    const t = toLocalIso(to);
    try {
      const list = await api.calendarFetchRange(f, t, null);
      this.merge(list, f, t);
      this.coverage.set(key, Date.now());
    } catch (e) {
      // Show whatever the cache has; try again on the next navigation.
      console.warn("calendar range fetch failed", e);
      this.coverage.set(key, Date.now() - COVERAGE_TTL + 30_000);
    } finally {
      this.pending.delete(key);
      this.fetching = this.pending.size > 0;
    }
  }

  /** Re-downloads the visible period (and kicks a sync for the window). */
  async refresh() {
    try {
      await api.calendarSync();
      const { from, to } = this.period;
      const f = toLocalIso(from);
      const t = toLocalIso(to);
      this.fetching = true;
      const [list] = await Promise.all([api.calendarFetchRange(f, t, null), this.loadCalendars()]);
      this.merge(list, f, t);
      for (let m = startOfMonth(from); m < to; m = addMonths(m, 1)) this.coverage.set(dayKey(m).slice(0, 7), Date.now());
    } catch (e) {
      toasts.error(errMsg(e));
    } finally {
      this.fetching = false;
    }
    await this.load({ silent: true });
  }

  async toggleCalendar(id: string) {
    const hidden = new Set(this.settings?.hiddenCalendars ?? []);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    await app.patchSettings((s) => (s.calendar.hiddenCalendars = [...hidden]));
  }

  /** Calendars the user can write to, for the composer's picker. */
  writableCalendars(accountId: string): Calendar[] {
    return this.calendars.filter((c) => c.accountId === accountId && c.canEdit);
  }

  // ---------- invitations ----------
  async invite(messageId: string): Promise<InviteInfo | null> {
    if (messageId in this.invites) return this.invites[messageId];
    if (this.inviteLoading.has(messageId)) return null;
    this.inviteLoading = new Set([...this.inviteLoading, messageId]);
    try {
      const info = await api.inviteGet(messageId);
      this.invites = { ...this.invites, [messageId]: info };
      return info;
    } catch (e) {
      console.warn("invite_get failed", e);
      this.invites = { ...this.invites, [messageId]: null };
      return null;
    } finally {
      const s = new Set(this.inviteLoading);
      s.delete(messageId);
      this.inviteLoading = s;
    }
  }

  private responseFor(action: InviteAction): CalEvent["response"] {
    return action === "accept" ? "accepted" : action === "decline" ? "declined" : "tentativelyAccepted";
  }

  private patchEverywhere(id: string, patch: (e: CalEvent) => CalEvent) {
    this.events = this.events.map((e) => (e.id === id ? patch(e) : e));
    this.invites = Object.fromEntries(
      Object.entries(this.invites).map(([k, v]) => [k, v && v.event?.id === id ? { ...v, event: patch(v.event) } : v]),
    );
  }

  /** Respond to an invitation; optimistic in both the events list and any cached invite. `proposed` = counter-proposal. */
  async respond(ev: CalEvent, action: InviteAction, comment: string | null = null, sendResponse = true, proposed: { start: string; end: string } | null = null) {
    const response = this.responseFor(action);
    const prev = ev.response;
    this.patchEverywhere(ev.id, (e) => ({ ...e, response }));
    try {
      await api.inviteRespond(ev.accountId, ev.id, action, comment, sendResponse, proposed);
      const verb = action === "accept" ? "Accepted" : action === "decline" ? "Declined" : "Tentatively accepted";
      const extra = proposed ? ` · proposed ${weekdayDayMonth(proposed.start)} ${hhmm(proposed.start)}` : sendResponse ? "" : " (no response sent)";
      toasts.show(`${verb} “${ev.subject || "(no title)"}”${extra}`, { kind: "success" });
      this.load({ silent: true });
    } catch (e) {
      this.patchEverywhere(ev.id, (x) => ({ ...x, response: prev }));
      toasts.error(`Could not respond: ${errMsg(e)}`);
      throw e;
    }
  }

  // ---------- create / edit / delete ----------
  async create(draft: EventDraft): Promise<CalEvent> {
    const created = await api.eventCreate(draft);
    this.events = sortEvents([...this.events.filter((e) => e.id !== created.id), created]);
    toasts.show(draft.recurrence ? `Created series “${created.subject}”` : `Created “${created.subject}”`, { kind: "success" });
    // Series occurrences only exist after the server expands them.
    if (draft.recurrence) setTimeout(() => this.refresh(), 1500);
    else this.load({ silent: true });
    return created;
  }

  async update(ev: CalEvent, patch: EventPatch, scope: EditScope = "occurrence"): Promise<CalEvent> {
    const prev = ev;
    // Optimistic for the fields we can show immediately.
    this.patchEverywhere(ev.id, (e) => ({
      ...e,
      subject: patch.subject ?? e.subject,
      start: patch.start ?? e.start,
      end: patch.end ?? e.end,
      isAllDay: patch.isAllDay ?? e.isAllDay,
      location: patch.location === undefined ? e.location : patch.location,
      showAs: patch.showAs ?? e.showAs,
    }));
    try {
      const updated = await api.eventUpdate(ev.accountId, ev.id, patch, scope);
      if (scope === "series") {
        toasts.show(`Updated series “${updated.subject}”`, { kind: "success" });
        setTimeout(() => this.refresh(), 1500);
      } else {
        this.events = sortEvents([...this.events.filter((e) => e.id !== ev.id && e.id !== updated.id), updated]);
        if (this.detailsId === ev.id) this.detailsId = updated.id;
        if (this.selectedId === ev.id) this.selectedId = updated.id;
      }
      return updated;
    } catch (e) {
      this.patchEverywhere(ev.id, () => prev);
      toasts.error(`Could not update: ${errMsg(e)}`);
      throw e;
    }
  }

  /** One click: private ↔ normal. */
  async togglePrivate(ev: CalEvent) {
    const next = ev.sensitivity === "private" ? "normal" : "private";
    const prev = ev.sensitivity;
    this.patchEverywhere(ev.id, (e) => ({ ...e, sensitivity: next }));
    try {
      const updated = await api.eventUpdate(ev.accountId, ev.id, { sensitivity: next }, "occurrence");
      this.events = sortEvents([...this.events.filter((e) => e.id !== ev.id && e.id !== updated.id), updated]);
      toasts.show(next === "private" ? `“${ev.subject || "(no title)"}” is now private` : `“${ev.subject || "(no title)"}” is no longer private`, { kind: "success" });
    } catch (e) {
      this.patchEverywhere(ev.id, (x) => ({ ...x, sensitivity: prev }));
      toasts.error(`Could not update: ${errMsg(e)}`);
    }
  }

  /** Blocks a free gap as private focus time (one click from the agenda / rail). */
  async createFocusBlock(start: string, end: string, accountId?: string | null) {
    const acct = accountId ?? app.accountFilter ?? app.accounts[0]?.id;
    if (!acct) return;
    const cal = this.writableCalendars(acct).find((c) => c.isDefault);
    try {
      await this.create({
        accountId: acct,
        calendarId: cal?.id ?? null,
        subject: "Focus time",
        start,
        end,
        isAllDay: false,
        attendees: [],
        isOnline: false,
        showAs: "busy",
        reminderMinutes: -1,
        sensitivity: "private",
        body: "Blocked by Tern so this time stays free for focused work.",
      });
    } catch (e) {
      toasts.error(`Could not block the time: ${errMsg(e)}`);
    }
  }

  /** Composes an email listing free slots for the coming workdays (for scheduling by mail). */
  async shareAvailability(days = 5, durationMins = 30) {
    const acct = app.accountFilter ?? app.accounts[0]?.id;
    if (!acct) return;
    const s = this.settings;
    try {
      const from = toLocalIso(new Date(Math.max(Date.now(), startOfDay(this.now).getTime())));
      const to = toLocalIso(addDays(startOfDay(this.now), days + 2));
      const slots = await api.freeSlots({ accountId: acct, attendees: [], from, to, durationMins, workStart: s?.workStart, workEnd: s?.workEnd });
      if (!slots.length) {
        toasts.show("No free slots in working hours in the coming days", { kind: "error", timeout: 4000 });
        return;
      }
      // Merge adjacent proposals into ranges per day for a readable list.
      const byDay = new Map<string, string[]>();
      for (const sl of slots) {
        const k = dayKey(sl.start);
        byDay.set(k, [...(byDay.get(k) ?? []), `${hhmm(sl.start)}–${hhmm(sl.end)}`]);
      }
      const lines = [...byDay.entries()].map(([k, times]) => `${weekdayDayMonth(k + "T00:00:00")}: ${times.join(", ")}`);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const text = `I'm free at the following times (${tz}):\n\n${lines.join("\n")}\n\nLet me know what suits you and I'll send an invitation.`;
      const { composer } = await import("./composer.svelte");
      const { textToHtml } = await import("$lib/ai");
      composer.compose({ accountId: acct, subject: "Available times", bodyHtml: textToHtml(text) });
    } catch (e) {
      toasts.error(`Could not check availability: ${errMsg(e)}`);
    }
  }

  // ---------- search ----------
  private searchSeq = 0;
  async search(q: string) {
    this.searchQuery = q;
    const seq = ++this.searchSeq;
    if (!q.trim()) {
      this.searchResults = [];
      this.searching = false;
      return;
    }
    this.searching = true;
    try {
      const res = await api.calendarSearch(q.trim(), 40);
      if (seq !== this.searchSeq) return;
      this.searchResults = res.filter((e) => !this.hidden.has(e.calendarId) && (!app.accountFilter || e.accountId === app.accountFilter));
    } catch {
      if (seq === this.searchSeq) this.searchResults = [];
    } finally {
      if (seq === this.searchSeq) this.searching = false;
    }
  }

  /** Jump to a search hit: navigate to its date, make sure it is loaded, open it. */
  jumpTo(ev: CalEvent) {
    if (!this.events.some((e) => e.id === ev.id)) this.events = sortEvents([...this.events, ev]);
    this.goto(new Date(ev.start), this.view === "month" || this.view === "agenda" ? this.view : "week");
    this.openDetails(ev.id);
  }

  // ---------- keyboard time cursor ----------
  /** Moves/creates the cursor. `dCol` days, `dMins` minutes; `grow` changes the length instead. */
  moveCursor(dCol: number, dMins: number, grow = false) {
    if (this.view !== "day" && this.view !== "week") return;
    const n = this.days.length;
    if (!this.cursor) {
      const todayIdx = this.days.findIndex((d) => dayKey(d) === dayKey(this.now));
      const base = Math.round((this.now.getHours() * 60 + this.now.getMinutes()) / 30) * 30;
      const ws = this.settings?.workStart ?? "09:00";
      const [wh, wm] = ws.split(":").map(Number);
      this.cursor = { col: todayIdx >= 0 ? todayIdx : 0, mins: todayIdx >= 0 ? Math.min(1410, base) : (wh || 9) * 60 + (wm || 0), len: this.settings?.defaultDurationMins ?? 30 };
      return;
    }
    const c = { ...this.cursor };
    if (grow) c.len = Math.max(15, Math.min(1440 - c.mins, c.len + dMins));
    else {
      c.mins = Math.max(0, Math.min(1440 - 30, c.mins + dMins));
      let col = c.col + dCol;
      if (col < 0) {
        this.prev();
        col = n - 1;
      } else if (col >= n) {
        this.next();
        col = 0;
      }
      c.col = col;
    }
    this.cursor = c;
  }

  cursorDay(): Date | null {
    return this.cursor ? (this.days[this.cursor.col] ?? null) : null;
  }

  /** Enter on the cursor: new event at that slot. */
  composeAtCursor() {
    const d = this.cursorDay();
    if (!d || !this.cursor) return;
    this.composeAt(d, this.cursor.mins, this.cursor.len);
  }

  /** Drag / resize: new local start & end. */
  async move(ev: CalEvent, start: string, end: string) {
    if (start === ev.start && end === ev.end) return;
    const updated = await this.update(ev, { start, end }, "occurrence");
    toasts.show(`Moved “${updated.subject}”`, {
      kind: "success",
      action: { label: "Undo", run: () => this.update(updated, { start: ev.start, end: ev.end }, "occurrence") },
    });
  }

  async remove(ev: CalEvent, scope: EditScope = "occurrence", comment: string | null = null) {
    const removed = scope === "series" && ev.seriesMasterId ? this.events.filter((e) => e.seriesMasterId === ev.seriesMasterId || e.id === ev.id) : [ev];
    const ids = new Set(removed.map((e) => e.id));
    this.events = this.events.filter((e) => !ids.has(e.id));
    if (this.detailsId && ids.has(this.detailsId)) this.openDetails(null);
    if (this.selectedId && ids.has(this.selectedId)) this.selectedId = null;
    try {
      await api.eventDelete(ev.accountId, ev.id, scope, comment);
      const organizer = ev.response === "organizer" && ev.attendees.length > 0;
      toasts.show(`${organizer ? "Cancelled" : "Deleted"} ${scope === "series" ? "series " : ""}“${ev.subject || "(no title)"}”`, { kind: "success" });
    } catch (e) {
      this.events = sortEvents([...this.events, ...removed]);
      toasts.error(`Could not delete: ${errMsg(e)}`);
      throw e;
    }
  }

  // ---------- UI helpers ----------
  openComposer(draft: ComposerDraft = {}) {
    this.composerEditing = null;
    this.composerScope = "occurrence";
    this.composerDraft = draft;
    this.composerOpen = true;
  }

  /** Opens the composer prefilled for `day` at `minutes` (from a click/drag on the grid). */
  composeAt(day: Date, minutes: number | null, durationMins?: number) {
    const dur = durationMins ?? this.settings?.defaultDurationMins ?? 30;
    if (minutes == null) {
      this.openComposer({ start: toLocalIso(day), end: toLocalIso(addDays(day, 1)), isAllDay: true });
      return;
    }
    const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
    this.openComposer({ start: toLocalIso(s), end: toLocalIso(new Date(s.getTime() + dur * 60_000)) });
  }

  openEditor(ev: CalEvent, scope: EditScope = "occurrence") {
    this.composerEditing = ev;
    this.composerScope = scope;
    this.composerDraft = null;
    this.composerOpen = true;
    this.detailsId = null;
  }

  duplicate(ev: CalEvent) {
    this.openComposer({
      accountId: ev.accountId,
      calendarId: ev.calendarId || null,
      subject: ev.subject,
      start: ev.start,
      end: ev.end,
      isAllDay: ev.isAllDay,
      location: ev.location,
      attendees: ev.attendees.filter((a) => a.type === "required").map((a) => a.addr),
      optionalAttendees: ev.attendees.filter((a) => a.type === "optional").map((a) => a.addr),
      isOnline: ev.isOnline,
      showAs: ev.showAs,
      reminderMinutes: ev.reminderMinutes ?? -1,
      sensitivity: ev.sensitivity === "private" ? "private" : "normal",
    });
    this.detailsId = null;
  }

  closeComposer() {
    this.composerOpen = false;
    this.composerDraft = null;
    this.composerEditing = null;
  }

  openDetails(id: string | null) {
    this.detailsId = id;
    this.detailsFull = null;
    if (id) {
      this.selectedId = id;
      const ev = this.events.find((e) => e.id === id);
      if (ev) {
        api
          .eventGet(ev.accountId, id)
          .then((full) => {
            if (this.detailsId === id) this.detailsFull = full;
            // Pick up fields the view only had from the cache (reminder, categories…).
            this.events = this.events.map((e) => (e.id === id ? { ...e, ...full.event } : e));
          })
          .catch(() => {});
      }
    }
  }

  /** Quick add: parse free text and open the composer prefilled (so the user can still adjust). */
  quickAdd(text: string, accountId?: string | null): boolean {
    const q = parseQuickAdd(text, this.now, this.settings?.defaultDurationMins ?? 30);
    if (!q) return false;
    this.openComposer({
      accountId: accountId ?? app.accountFilter ?? undefined,
      subject: q.subject === "(no title)" ? "" : q.subject,
      start: toLocalIso(q.start),
      end: toLocalIso(q.end),
      isAllDay: q.allDay,
      isOnline: q.isOnline,
      location: q.location,
      sensitivity: q.isPrivate ? "private" : null,
      // The composer turns the preset into a Graph recurrence anchored on the start.
      repeat: q.repeat,
    });
    return true;
  }

  /** `#` / Delete: open the details with the delete confirmation (never deletes without confirming). */
  requestDelete(ev: CalEvent) {
    this.openDetails(ev.id);
    this.deleteRequest++;
  }

  /** Keyboard navigation across the events of the current period. */
  moveSelection(delta: number) {
    const flat = this.inPeriod;
    if (!flat.length) return;
    const i = flat.findIndex((e) => e.id === this.selectedId);
    const next = i < 0 ? (delta > 0 ? 0 : flat.length - 1) : Math.max(0, Math.min(flat.length - 1, i + delta));
    this.selectedId = flat[next].id;
    if (this.detailsId) this.openDetails(this.selectedId);
    document.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(this.selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const calendar = new CalendarState();
