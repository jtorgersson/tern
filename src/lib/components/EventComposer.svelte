<script lang="ts">
  // Event sheet: create or edit. Title, calendar, when (with quick-parse of the title), repeat, people (required /
  // optional), Teams, location, show-as, reminder, private, notes, and "Find a time" free-slot chips.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { api } from "$lib/api";
  import type { Addr, EventDraft, EventFull, EventPatch, FreeSlot, Recurrence, ShowAs } from "$lib/types";
  import { addDays, dayKey, hm, startOfDay, toLocalIso, dayLabel, presetRecurrence, recurrencePreset, recurrenceLabel, type RepeatPreset } from "$lib/util/cal";
  import { dayMonth } from "$lib/util/fmt";
  import { parseQuickAdd } from "$lib/util/quickadd";
  import { hueColor } from "$lib/theme";
  import { errMsg } from "$lib/util/misc";
  import AddressInput from "./AddressInput.svelte";
  import AvailabilityStrip from "./AvailabilityStrip.svelte";
  import { X, Video, MapPin, Sparkles, LoaderCircle, Calendar as CalIcon, Clock, AlignLeft, Repeat, Bell, Lock, Users, Zap, Trash2 } from "@lucide/svelte";
  import { tick, untrack } from "svelte";

  const open = $derived(calendar.composerOpen);
  const editing = $derived(calendar.composerEditing);

  let accountId = $state("");
  let calendarId = $state("");
  let subject = $state("");
  let date = $state("");
  let endDate = $state("");
  let startT = $state("10:00");
  let endT = $state("10:30");
  let allDay = $state(false);
  let location = $state("");
  let attendees = $state<Addr[]>([]);
  let optional = $state<Addr[]>([]);
  let showOptional = $state(false);
  let online = $state(true);
  let body = $state("");
  let showAs = $state<ShowAs>("busy");
  let reminder = $state(15);
  let isPrivate = $state(false);
  let repeat = $state<RepeatPreset | "custom">("none");
  let repeatUntil = $state("");
  let customRecurrence = $state<Recurrence | null>(null);
  let saving = $state(false);
  let finding = $state(false);
  let slots = $state<FreeSlot[]>([]);
  let slotRange = $state(7);
  let subjectEl: HTMLInputElement | undefined = $state();
  let more = $state(false);
  /** Original recurrence rule when editing a series, so we only send it when changed. */
  let origRecurrence: Recurrence | null = null;

  const pad = (n: number) => String(n).padStart(2, "0");
  const hm24 = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function roundUpHalfHour(d: Date): Date {
    const x = new Date(d);
    x.setSeconds(0, 0);
    x.setMinutes(x.getMinutes() <= 30 ? 30 : 60);
    return x;
  }

  // Reset from the draft / the event being edited each time the sheet opens (and only then: untrack keeps
  // later store changes, e.g. a calendar refresh, from wiping what the user typed).
  $effect(() => {
    if (!open) return;
    untrack(() => resetForm());
  });
  /** Series master (fetched when editing a whole series) so the form edits the series' own start, not the clicked occurrence. */
  let master = $state<EventFull | null>(null);
  function resetForm() {
    master = null;
    const cal = app.settings?.calendar;
    const ev = calendar.composerEditing;
    const d: Partial<EventDraft> & { repeat?: RepeatPreset } = ev
      ? {
          accountId: ev.accountId,
          calendarId: ev.calendarId,
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
          body: calendar.detailsFull?.event.id === ev.id ? calendar.detailsFull.bodyText : ev.preview,
        }
      : (calendar.composerDraft ?? {});
    accountId = d.accountId ?? app.accountFilter ?? app.accounts[0]?.id ?? "";
    const writable = calendar.writableCalendars(accountId);
    calendarId = d.calendarId && writable.some((c) => c.id === d.calendarId) ? d.calendarId : (writable.find((c) => c.isDefault)?.id ?? "");
    subject = d.subject ?? "";
    const dur = calendar.defaultDuration();
    const s = d.start ? new Date(d.start) : roundUpHalfHour(new Date());
    const e = d.end ? new Date(d.end) : new Date(s.getTime() + dur * 60_000);
    date = dayKey(s);
    allDay = d.isAllDay ?? false;
    endDate = allDay ? dayKey(new Date(e.getTime() - 1)) : dayKey(e);
    startT = hm24(s);
    endT = hm24(e);
    location = d.location ?? "";
    attendees = d.attendees ?? [];
    optional = d.optionalAttendees ?? [];
    showOptional = optional.length > 0;
    online = d.isOnline ?? true;
    body = d.body ?? "";
    showAs = (d.showAs as ShowAs) ?? "busy";
    reminder = d.reminderMinutes ?? cal?.defaultReminderMinutes ?? 15;
    isPrivate = d.sensitivity === "private";
    const rec = ev ? (calendar.detailsFull?.event.id === ev.id ? calendar.detailsFull.recurrence : null) : (d.recurrence ?? null);
    origRecurrence = rec;
    customRecurrence = rec;
    repeat = ev ? (ev.seriesMasterId && !rec ? "custom" : recurrencePreset(rec)) : (d.repeat ?? recurrencePreset(rec));
    repeatUntil = rec?.range?.type === "endDate" ? (rec.range.endDate ?? "") : "";
    slots = [];
    more = !!ev || showAs !== "busy" || isPrivate;
    tick().then(() => subjectEl?.focus());
    if (ev && calendar.composerScope === "series" && ev.seriesMasterId) loadMaster(ev.accountId, ev.seriesMasterId);
  }

  /** Whole-series edits apply to the master: show its start date, duration, notes and rule. */
  async function loadMaster(accountId: string, masterId: string) {
    try {
      const full = await api.eventGet(accountId, masterId);
      if (!calendar.composerOpen || calendar.composerScope !== "series" || calendar.composerEditing?.seriesMasterId !== masterId) return;
      master = full;
      const m = full.event;
      const s = new Date(m.start);
      const e = new Date(m.end);
      date = dayKey(s);
      allDay = m.isAllDay;
      endDate = allDay ? dayKey(new Date(e.getTime() - 1)) : dayKey(e);
      startT = hm24(s);
      endT = hm24(e);
      body = full.bodyText;
      origRecurrence = full.recurrence;
      customRecurrence = full.recurrence;
      repeat = recurrencePreset(full.recurrence);
      repeatUntil = full.recurrence?.range?.type === "endDate" ? (full.recurrence.range.endDate ?? "") : "";
    } catch (e) {
      toasts.error(`Could not load the series: ${errMsg(e)}`);
    }
  }
  const masterPending = $derived(!!editing && calendar.composerScope === "series" && !!editing.seriesMasterId && !master);

  const durationMins = $derived.by(() => {
    const s = new Date(`${date}T${startT}:00`).getTime();
    const e = new Date(`${endDate || date}T${endT}:00`).getTime();
    return Math.max(5, Math.round((e - s) / 60_000));
  });
  const multiDay = $derived(!allDay && endDate && endDate !== date);

  function onStartChange() {
    // Keep the duration when the start moves.
    const dur = durationMins > 0 ? durationMins : 30;
    const s = new Date(`${date}T${startT}:00`);
    const e = new Date(s.getTime() + dur * 60_000);
    endT = hm24(e);
    endDate = dayKey(e);
  }
  function onDateChange() {
    if (!endDate || endDate < date) endDate = date;
  }

  function startIso(): string {
    return allDay ? `${date}T00:00:00` : `${date}T${startT}:00`;
  }
  function endIso(): string {
    if (allDay) return `${dayKey(addDays(new Date((endDate || date) + "T00:00:00"), 1))}T00:00:00`;
    return `${endDate || date}T${endT}:00`;
  }

  /** Title quick-parse: "Lunch tomorrow 12" typed in the title fills in the time (new events only). */
  const titleHint = $derived.by(() => {
    if (editing || !subject.trim()) return null;
    const q = parseQuickAdd(subject, calendar.now, calendar.defaultDuration());
    if (!q || (!q.matched.date && !q.matched.time)) return null;
    if (q.subject === subject.trim()) return null;
    return q;
  });
  function applyTitleHint() {
    const q = titleHint;
    if (!q) return;
    subject = q.subject === "(no title)" ? "" : q.subject;
    date = dayKey(q.start);
    allDay = q.allDay;
    endDate = q.allDay ? dayKey(new Date(q.end.getTime() - 1)) : dayKey(q.end);
    startT = hm24(q.start);
    endT = hm24(q.end);
    if (q.location) location = q.location;
    if (q.isOnline) online = true;
    if (q.repeat !== "none") repeat = q.repeat;
  }

  const recurrence = $derived.by<Recurrence | null>(() => {
    if (repeat === "none") return null;
    if (repeat === "custom") return customRecurrence;
    return presetRecurrence(repeat, new Date(`${date}T00:00:00`), repeatUntil || null);
  });

  async function findTime() {
    if (!accountId) return;
    finding = true;
    slots = [];
    try {
      const from = toLocalIso(new Date(Math.max(Date.now(), startOfDay().getTime())));
      const to = toLocalIso(addDays(startOfDay(), slotRange));
      const res = await api.freeSlots({
        accountId,
        attendees: [...attendees, ...optional].map((a) => a.email),
        from,
        to,
        durationMins: Math.max(15, durationMins),
        workStart: app.settings?.calendar?.workStart,
        workEnd: app.settings?.calendar?.workEnd,
      });
      slots = res.slice(0, 6);
      if (!res.length) toasts.show("No free slots in that range within working hours", { kind: "error", timeout: 4000 });
    } catch (e) {
      toasts.error(`Could not check availability: ${errMsg(e)}`);
    } finally {
      finding = false;
    }
  }

  function useSlot(s: FreeSlot) {
    const dur = Math.max(15, durationMins);
    const st = new Date(s.start);
    date = dayKey(st);
    endDate = date;
    startT = hm24(st);
    endT = hm24(new Date(st.getTime() + dur * 60_000));
    allDay = false;
  }

  function slotLabel(s: FreeSlot): string {
    const d = new Date(s.start);
    return `${dayLabel(d, calendar.now).slice(0, 3)} ${dayMonth(d)} · ${hm(s.start)}`;
  }

  const durLabel = $derived(durationMins >= 60 ? `${Math.floor(durationMins / 60)}h${durationMins % 60 ? ` ${durationMins % 60}m` : ""}` : `${durationMins}m`);
  const conflicts = $derived.by(() => {
    if (allDay || !date) return [];
    const s = startIso();
    const e = endIso();
    return calendar.events.filter((o) => o.accountId === accountId && o.id !== editing?.id && !o.isAllDay && !o.isCancelled && o.response !== "declined" && o.showAs !== "free" && o.start < e && o.end > s).slice(0, 3);
  });

  async function save() {
    if (!subject.trim()) {
      subjectEl?.focus();
      return;
    }
    if (endIso() <= startIso()) {
      toasts.error("End must be after the start");
      return;
    }
    saving = true;
    try {
      if (editing) {
        const patch: EventPatch = {
          subject: subject.trim(),
          start: startIso(),
          end: endIso(),
          isAllDay: allDay,
          location: location.trim() || null,
          attendees,
          optionalAttendees: optional,
          isOnline: online && attendees.length + optional.length > 0,
          showAs,
          reminderMinutes: reminder < 0 ? null : reminder,
          sensitivity: isPrivate ? "private" : "normal",
        };
        const scope = calendar.composerScope;
        if (scope === "series" && masterPending) {
          toasts.error("Still loading the series — try again in a moment");
          return;
        }
        const origBody = master ? master.bodyText : calendar.detailsFull?.event.id === editing.id ? calendar.detailsFull.bodyText : editing.preview;
        if (body.trim() !== origBody.trim()) patch.body = body.trim() || null;
        // Repeat rule: for a series (edits the master) or when turning a single event into a series.
        if ((scope === "series" || !editing.seriesMasterId) && JSON.stringify(recurrence) !== JSON.stringify(origRecurrence)) patch.recurrence = recurrence;
        const ev = await calendar.update(editing, patch, scope);
        calendar.closeComposer();
        if (scope !== "series") calendar.openDetails(ev.id);
      } else {
        const draft: EventDraft = {
          accountId,
          calendarId: calendarId || null,
          subject: subject.trim(),
          start: startIso(),
          end: endIso(),
          isAllDay: allDay,
          location: location.trim() || null,
          body: body.trim() || null,
          attendees,
          optionalAttendees: optional,
          isOnline: online && attendees.length + optional.length > 0,
          showAs,
          reminderMinutes: reminder,
          sensitivity: isPrivate ? "private" : "normal",
          recurrence,
        };
        const ev = await calendar.create(draft);
        calendar.closeComposer();
        if (app.view.kind === "calendar") {
          calendar.goto(new Date(ev.start));
          calendar.openDetails(ev.id);
        }
      }
    } catch (e) {
      if (!editing) toasts.error(`Could not create event: ${errMsg(e)}`);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!editing) return;
    saving = true;
    try {
      await calendar.remove(editing, calendar.composerScope);
      calendar.closeComposer();
    } catch {
      /* toast */
    } finally {
      saving = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  }

  const REPEATS: { id: RepeatPreset; label: string }[] = [
    { id: "none", label: "Does not repeat" },
    { id: "daily", label: "Every day" },
    { id: "weekdays", label: "Every weekday" },
    { id: "weekly", label: "Every week" },
    { id: "biweekly", label: "Every 2 weeks" },
    { id: "monthly", label: "Every month" },
    { id: "yearly", label: "Every year" },
  ];
  const REMINDERS = [-1, 0, 5, 10, 15, 30, 60, 120, 1440];
  const remLabel = (m: number) => (m < 0 ? "No reminder" : m === 0 ? "At start" : m < 60 ? `${m} min before` : m < 1440 ? `${m / 60} h before` : "1 day before");
  const hasGuests = $derived(attendees.length + optional.length > 0);
  const calsForAccount = $derived(calendar.writableCalendars(accountId));
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => calendar.closeComposer()}>
    <div class="sheet" data-event-composer onclick={(e) => e.stopPropagation()} {onkeydown} role="dialog" aria-label={editing ? "Edit event" : "New event"} tabindex="-1">
      <header>
        <CalIcon size={15} />
        <span class="t">{editing ? (calendar.composerScope === "series" ? "Edit series" : editing.seriesMasterId ? "Edit this occurrence" : "Edit event") : "New event"}</span>
        <span class="spacer"></span>
        <button class="icon-btn s" title="Close (Esc)" onclick={() => calendar.closeComposer()}><X size={14} /></button>
      </header>

      <input class="subject" bind:this={subjectEl} bind:value={subject} placeholder={editing ? "Title" : "Add a title — try “Lunch with Anna tomorrow 12”"} />
      {#if titleHint}
        <button class="hintline" onclick={applyTitleHint}>
          <Zap size={12} />
          <span><b>{titleHint.subject}</b> · {titleHint.allDay ? dayMonth(titleHint.start) + " · all day" : `${dayLabel(titleHint.start, calendar.now)} ${hm24(titleHint.start)}–${hm24(titleHint.end)}`}{titleHint.repeat !== "none" ? ` · ${recurrenceLabel(presetRecurrence(titleHint.repeat, titleHint.start)).toLowerCase()}` : ""}</span>
          <kbd>Tab</kbd>
        </button>
      {/if}

      {#if app.accounts.length > 1 || calsForAccount.length > 1}
        <div class="row from">
          <span class="lbl">Calendar</span>
          {#if app.accounts.length > 1 && !editing}
            <span class="fdot" style:background={hueColor(app.accountById.get(accountId)?.hue ?? 0, app.mode)}></span>
            <select bind:value={accountId} onchange={() => (calendarId = calendar.writableCalendars(accountId).find((c) => c.isDefault)?.id ?? "")}>
              {#each app.accounts as a (a.id)}<option value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>{/each}
            </select>
          {/if}
          {#if calsForAccount.length > 1 && !editing}
            <select bind:value={calendarId}>
              {#each calsForAccount as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
            </select>
          {:else if editing}
            <span class="calname">{calendar.calendarById.get(editing.calendarId)?.name ?? "Calendar"}{app.accounts.length > 1 ? ` · ${app.accountById.get(editing.accountId)?.email ?? ""}` : ""}</span>
          {/if}
        </div>
      {/if}

      <div class="row when">
        <Clock size={14} />
        <input type="date" class="field" bind:value={date} onchange={onDateChange} />
        {#if !allDay}
          <input type="time" class="field" bind:value={startT} onchange={onStartChange} step="300" />
          <span class="dash">–</span>
          <input type="time" class="field" bind:value={endT} step="300" />
          {#if multiDay}<input type="date" class="field" bind:value={endDate} />{/if}
          <span class="dur mono" title={multiDay ? "" : "Click to end on another day"}><button class="plainbtn" onclick={() => (endDate = multiDay ? date : dayKey(addDays(new Date(date + "T00:00:00"), 1)))}>{durLabel}</button></span>
        {:else}
          <span class="dash">–</span>
          <input type="date" class="field" bind:value={endDate} min={date} />
        {/if}
        <label class="chk"><input type="checkbox" bind:checked={allDay} /> All day</label>
      </div>

      {#if conflicts.length}
        <div class="conflict">Overlaps {#each conflicts as c, i (c.id)}{i ? ", " : ""}<b>{c.subject || "(no title)"}</b> <span class="mono">{hm(c.start)}–{hm(c.end)}</span>{/each}</div>
      {/if}

      <div class="row repeat">
        <Repeat size={14} />
        {#if repeat === "custom"}
          <span class="custom">{recurrenceLabel(customRecurrence) || "Custom repeat"}</span>
          <button class="link" onclick={() => (repeat = "none")}>Clear</button>
        {:else}
          <select bind:value={repeat} disabled={!!editing && calendar.composerScope !== "series" && !!editing.seriesMasterId}>
            {#each REPEATS as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
          </select>
          {#if repeat !== "none"}
            <span class="lbl">until</span>
            <input type="date" class="field" bind:value={repeatUntil} min={date} />
            {#if repeatUntil}<button class="link" onclick={() => (repeatUntil = "")}>forever</button>{/if}
          {/if}
        {/if}
        {#if editing?.seriesMasterId && calendar.composerScope !== "series"}
          <button class="link" onclick={() => calendar.openEditor(editing!, "series")}>Edit whole series</button>
        {/if}
      </div>

      <div class="row people">
        <AddressInput label="Invite" bind:value={attendees} />
        {#if !showOptional}<button class="link" onclick={() => (showOptional = true)}>+ optional</button>{/if}
      </div>
      {#if showOptional}
        <div class="row people">
          <AddressInput label="Optional" bind:value={optional} />
        </div>
      {/if}

      <div class="row opts">
        <label class="chk" class:off={!hasGuests} title={hasGuests ? "" : "Add attendees to create a Teams link"}>
          <input type="checkbox" bind:checked={online} disabled={!hasGuests} /><Video size={13} /> Teams meeting
        </label>
        <span class="loc"><MapPin size={13} /><input class="plain" bind:value={location} placeholder="Location" /></span>
      </div>

      {#if !allDay && hasGuests && !multiDay}
        {@const acct = app.accountById.get(accountId)}
        {#if acct}
          <AvailabilityStrip
            {accountId}
            me={{ name: acct.displayName, email: acct.email }}
            people={[...attendees, ...optional]}
            {date}
            start={startT}
            end={endT}
            workStart={app.settings?.calendar.workStart ?? "09:00"}
            workEnd={app.settings?.calendar.workEnd ?? "17:00"}
            onpick={(t) => {
              const dur = durationMins;
              startT = t;
              const e = new Date(new Date(`${date}T${t}:00`).getTime() + dur * 60_000);
              endT = hm24(e);
              endDate = dayKey(e);
            }} />
        {/if}
      {/if}

      {#if !allDay}
        <div class="find">
          <button class="btn sm" onclick={findTime} disabled={finding}>
            {#if finding}<LoaderCircle size={13} class="spin" />{:else}<Sparkles size={13} />{/if}
            Find a time{hasGuests ? ` with ${attendees.length + optional.length} ${attendees.length + optional.length === 1 ? "person" : "people"}` : ""}
          </button>
          <select class="range" bind:value={slotRange}>
            <option value={2}>next 2 days</option>
            <option value={7}>this week</option>
            <option value={14}>2 weeks</option>
            <option value={30}>this month</option>
          </select>
          {#if slots.length}
            <div class="slots">
              {#each slots as s (s.start)}
                <button class="slot" class:on={s.start === startIso()} onclick={() => useSlot(s)}>{slotLabel(s)}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if more}
        <div class="row extras">
          <span class="ex"><Users size={13} /><select bind:value={showAs}>
            <option value="busy">Busy</option>
            <option value="tentative">Tentative</option>
            <option value="free">Free</option>
            <option value="oof">Out of office</option>
            <option value="workingElsewhere">Working elsewhere</option>
          </select></span>
          <span class="ex"><Bell size={13} /><select bind:value={reminder}>
            {#each REMINDERS as m (m)}<option value={m}>{remLabel(m)}</option>{/each}
          </select></span>
          <label class="chk"><input type="checkbox" bind:checked={isPrivate} /><Lock size={12} /> Private</label>
        </div>
      {:else}
        <button class="link more" onclick={() => (more = true)}>Show as · reminder · private</button>
      {/if}

      <div class="notes">
        <AlignLeft size={14} />
        <textarea bind:value={body} rows="3" placeholder="Agenda or notes (optional)"></textarea>
      </div>

      <footer>
        <button class="btn primary" onclick={save} disabled={saving || masterPending}>
          {#if saving || masterPending}<LoaderCircle size={14} class="spin" />{/if}
          {editing ? (hasGuests ? "Save & send update" : "Save") : hasGuests ? "Send invitation" : "Save"} <kbd>^↵</kbd>
        </button>
        <button class="btn ghost" onclick={() => calendar.closeComposer()}>Cancel</button>
        <span class="spacer"></span>
        {#if editing}
          <button class="btn ghost danger" onclick={remove} disabled={saving} title={calendar.composerScope === "series" ? "Delete the whole series" : "Delete"}><Trash2 size={13} /> {calendar.composerScope === "series" ? "Delete series" : "Delete"}</button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<svelte:window
  onkeydown={(e) => {
    if (open && titleHint && e.key === "Tab" && document.activeElement === subjectEl) {
      e.preventDefault();
      applyTitleHint();
    }
  }} />

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 46;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--bg-darker) 45%, transparent);
    animation: fade 140ms;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .sheet {
    width: min(640px, calc(100vw - 40px));
    max-height: calc(100vh - 60px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 18px 16px;
    border-radius: 16px;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: var(--shadow);
    animation: fade-up 200ms var(--ease);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
  }
  .t {
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .spacer {
    flex: 1;
  }
  .subject {
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
    padding: 4px 0 8px;
    border-bottom: 1px solid var(--line);
    background: transparent;
  }
  .subject::placeholder {
    color: var(--muted);
    font-weight: 500;
  }
  .hintline {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: -4px;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--accent);
    background: var(--accent-soft);
    text-align: left;
  }
  .hintline b {
    color: var(--fg-bright);
    font-weight: 600;
  }
  .hintline kbd {
    margin-left: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fg-dim);
    min-width: 0;
    flex-wrap: wrap;
  }
  .lbl {
    font-size: 12px;
    color: var(--muted);
  }
  .fdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .from select,
  .repeat select,
  .extras select {
    font-size: 12.5px;
    color: var(--fg);
    background: transparent;
  }
  .calname {
    font-size: 12.5px;
    color: var(--fg);
  }
  .when .field,
  .repeat .field {
    height: 30px;
    padding: 0 8px;
    font-size: 12.5px;
    font-family: var(--font-mono);
    width: auto;
  }
  input[type="date"] {
    width: 150px;
  }
  input[type="time"] {
    width: 92px;
  }
  .dash {
    color: var(--muted);
  }
  .dur {
    font-size: 11px;
    color: var(--muted);
  }
  .plainbtn {
    font: inherit;
    color: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .chk {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--fg-dim);
    margin-left: auto;
    white-space: nowrap;
  }
  .opts .chk,
  .extras .chk {
    margin-left: 0;
  }
  .chk.off {
    opacity: 0.55;
  }
  .conflict {
    font-size: 12px;
    color: var(--red);
    padding: 6px 10px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--red) 10%, transparent);
  }
  .conflict b {
    color: var(--fg-bright);
    font-weight: 600;
  }
  .conflict .mono {
    font-size: 11px;
  }
  .custom {
    font-size: 12.5px;
    color: var(--fg);
  }
  .link {
    font-size: 12px;
    color: var(--accent);
  }
  .link.more {
    align-self: flex-start;
    margin: -2px 0 0 22px;
  }
  .people :global(.addr) {
    flex: 1;
  }
  .opts {
    gap: 16px;
  }
  .loc {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }
  .plain {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--fg);
    background: transparent;
    padding: 4px 0;
    border-bottom: 1px solid transparent;
  }
  .plain:focus {
    border-bottom-color: var(--accent-line);
  }
  .find {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--accent) 7%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 18%, var(--line));
  }
  .range {
    font-size: 11.5px;
    color: var(--fg-dim);
    background: transparent;
  }
  .slots {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: 2px;
  }
  .slot {
    height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-family: var(--font-mono);
    color: var(--fg);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: all var(--t);
  }
  .slot:hover {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .slot.on {
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: none;
  }
  .extras {
    gap: 18px;
  }
  .ex {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .notes {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    color: var(--fg-dim);
  }
  .notes textarea {
    flex: 1;
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg);
    background: transparent;
    resize: vertical;
    min-height: 56px;
    padding: 2px 0;
  }
  footer {
    display: flex;
    gap: 8px;
    align-items: center;
    padding-top: 4px;
  }
  footer kbd {
    margin-left: 4px;
  }
</style>
