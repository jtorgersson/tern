// Calendar store: cached events for the sync window, invites per message, responses and creation.
import { api } from "$lib/api";
import type { CalEvent, EventDraft, InviteAction, InviteInfo } from "$lib/types";
import { addDays, eventsOnDay, isBusy, overlaps, sortEvents, startOfDay, toLocalIso } from "$lib/util/cal";
import { errMsg } from "$lib/util/misc";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";

const WINDOW_BACK_DAYS = 7;
const WINDOW_AHEAD_DAYS = 21;

class CalendarState {
  events = $state<CalEvent[]>([]);
  loading = $state(false);
  loadedOnce = $state(false);
  /** Ticks every 30s so "now" markers and "in 25 min" labels move. */
  now = $state(new Date());

  /** Agenda selection / details popover. */
  selectedId = $state<string | null>(null);
  detailsId = $state<string | null>(null);
  composerOpen = $state(false);
  composerDraft = $state<Partial<EventDraft> | null>(null);

  /** Invitation details cached per message id. */
  invites = $state<Record<string, InviteInfo | null>>({});
  inviteLoading = $state<Set<string>>(new Set());

  private seq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    if (typeof window !== "undefined") {
      this.timer = setInterval(() => (this.now = new Date()), 30_000);
    }
  }

  /** Events for the active account filter. */
  visible = $derived(this.events.filter((e) => !app.accountFilter || e.accountId === app.accountFilter));
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

  byDay(days = 7): { day: Date; events: CalEvent[] }[] {
    const out: { day: Date; events: CalEvent[] }[] = [];
    const base = startOfDay(this.now);
    for (let i = 0; i < days; i++) {
      const day = addDays(base, i);
      out.push({ day, events: eventsOnDay(this.visible, day) });
    }
    return out;
  }

  async load(opts: { silent?: boolean } = {}) {
    const seq = ++this.seq;
    if (!opts.silent) this.loading = true;
    try {
      const from = toLocalIso(addDays(startOfDay(this.now), -WINDOW_BACK_DAYS));
      const to = toLocalIso(addDays(startOfDay(this.now), WINDOW_AHEAD_DAYS + 1));
      const list = await api.calendarEvents(from, to, null);
      if (seq !== this.seq) return;
      this.events = sortEvents(list);
      this.loadedOnce = true;
    } catch (e) {
      if (seq === this.seq && !opts.silent) toasts.error(`Calendar: ${errMsg(e)}`);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
  }

  async refresh() {
    try {
      await api.calendarSync();
    } catch (e) {
      toasts.error(errMsg(e));
    }
    // The sync emits calendar://changed which reloads; also reload now for snappiness.
    await this.load({ silent: true });
  }

  /** Other busy events on the same account that overlap. */
  conflictsFor(ev: CalEvent): CalEvent[] {
    if (ev.isAllDay) return [];
    return this.events.filter((o) => o.id !== ev.id && o.accountId === ev.accountId && !o.isAllDay && isBusy(o) && overlaps(o, ev));
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

  /** Respond to an invitation; optimistic in both the events list and any cached invite. */
  async respond(ev: CalEvent, action: InviteAction, comment: string | null = null, sendResponse = true) {
    const response = this.responseFor(action);
    const prev = ev.response;
    const patch = (e: CalEvent) => (e.id === ev.id ? { ...e, response } : e);
    this.events = this.events.map(patch);
    this.invites = Object.fromEntries(
      Object.entries(this.invites).map(([k, v]) => [k, v && v.event?.id === ev.id ? { ...v, event: { ...v.event, response } } : v]),
    );
    try {
      await api.inviteRespond(ev.accountId, ev.id, action, comment, sendResponse);
      const verb = action === "accept" ? "Accepted" : action === "decline" ? "Declined" : "Tentatively accepted";
      toasts.show(`${verb} “${ev.subject || "(no title)"}”${sendResponse ? "" : " (no response sent)"}`, { kind: "success" });
      this.load({ silent: true });
    } catch (e) {
      const undo = (x: CalEvent) => (x.id === ev.id ? { ...x, response: prev } : x);
      this.events = this.events.map(undo);
      this.invites = Object.fromEntries(
        Object.entries(this.invites).map(([k, v]) => [k, v && v.event?.id === ev.id ? { ...v, event: { ...v.event, response: prev } } : v]),
      );
      toasts.error(`Could not respond: ${errMsg(e)}`);
      throw e;
    }
  }

  async create(draft: EventDraft): Promise<CalEvent> {
    const created = await api.eventCreate(draft);
    this.events = sortEvents([...this.events.filter((e) => e.id !== created.id), created]);
    toasts.show(`Created “${created.subject}”`, { kind: "success" });
    this.load({ silent: true });
    return created;
  }

  // ---------- UI helpers ----------
  openComposer(draft: Partial<EventDraft> = {}) {
    this.composerDraft = draft;
    this.composerOpen = true;
  }

  closeComposer() {
    this.composerOpen = false;
    this.composerDraft = null;
  }

  openDetails(id: string | null) {
    this.detailsId = id;
    if (id) this.selectedId = id;
  }

  /** Keyboard navigation across the 7-day agenda. */
  moveSelection(delta: number) {
    const flat = this.byDay(7).flatMap((d) => d.events);
    if (!flat.length) return;
    const i = flat.findIndex((e) => e.id === this.selectedId);
    const next = i < 0 ? (delta > 0 ? 0 : flat.length - 1) : Math.max(0, Math.min(flat.length - 1, i + delta));
    this.selectedId = flat[next].id;
    if (this.detailsId) this.detailsId = this.selectedId;
    document.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(this.selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

export const calendar = new CalendarState();
