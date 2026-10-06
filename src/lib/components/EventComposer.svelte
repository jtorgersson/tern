<script lang="ts">
  // New event sheet with "Find a time" free-slot chips.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { api } from "$lib/api";
  import type { Addr, EventDraft, FreeSlot } from "$lib/types";
  import { addDays, dayKey, hm, startOfDay, toLocalIso, dayLabel } from "$lib/util/cal";
  import { hueColor } from "$lib/theme";
  import { errMsg } from "$lib/util/misc";
  import AddressInput from "./AddressInput.svelte";
  import { X, Video, MapPin, Sparkles, LoaderCircle, Calendar as CalIcon, Clock, AlignLeft } from "@lucide/svelte";
  import { tick } from "svelte";

  const open = $derived(calendar.composerOpen);

  let accountId = $state("");
  let subject = $state("");
  let date = $state("");
  let startT = $state("10:00");
  let endT = $state("10:30");
  let allDay = $state(false);
  let location = $state("");
  let attendees = $state<Addr[]>([]);
  let online = $state(true);
  let body = $state("");
  let saving = $state(false);
  let finding = $state(false);
  let slots = $state<FreeSlot[]>([]);
  let slotRange = $state(7);
  let subjectEl: HTMLInputElement | undefined = $state();

  function roundUpHalfHour(d: Date): Date {
    const x = new Date(d);
    x.setSeconds(0, 0);
    const m = x.getMinutes();
    x.setMinutes(m <= 30 ? 30 : 60);
    return x;
  }

  // Reset from the draft each time the sheet opens.
  $effect(() => {
    if (!open) return;
    const d = calendar.composerDraft ?? {};
    accountId = d.accountId ?? app.accountFilter ?? app.accounts[0]?.id ?? "";
    subject = d.subject ?? "";
    const s = d.start ? new Date(d.start) : roundUpHalfHour(new Date());
    const e = d.end ? new Date(d.end) : new Date(s.getTime() + 30 * 60_000);
    date = dayKey(s);
    startT = `${String(s.getHours()).padStart(2, "0")}:${String(s.getMinutes()).padStart(2, "0")}`;
    endT = `${String(e.getHours()).padStart(2, "0")}:${String(e.getMinutes()).padStart(2, "0")}`;
    allDay = d.isAllDay ?? false;
    location = d.location ?? "";
    attendees = d.attendees ?? [];
    online = d.isOnline ?? true;
    body = d.body ?? "";
    slots = [];
    tick().then(() => subjectEl?.focus());
  });

  const durationMins = $derived.by(() => {
    const [sh, sm] = startT.split(":").map(Number);
    const [eh, em] = endT.split(":").map(Number);
    return Math.max(5, (eh * 60 + em) - (sh * 60 + sm));
  });

  function onStartChange() {
    // keep the duration when the start moves
    const dur = durationMins;
    const [sh, sm] = startT.split(":").map(Number);
    const total = sh * 60 + sm + (dur > 0 ? dur : 30);
    endT = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function startIso(): string {
    return allDay ? `${date}T00:00:00` : `${date}T${startT}:00`;
  }
  function endIso(): string {
    if (allDay) return `${dayKey(addDays(new Date(date + "T00:00:00"), 1))}T00:00:00`;
    return `${date}T${endT}:00`;
  }

  async function findTime() {
    if (!accountId) return;
    finding = true;
    slots = [];
    try {
      const from = toLocalIso(new Date(Math.max(Date.now(), startOfDay().getTime())));
      const to = toLocalIso(addDays(startOfDay(), slotRange));
      const res = await api.freeSlots({
        accountId,
        attendees: attendees.map((a) => a.email),
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
    // Capture the current duration before moving the start, then keep it.
    const dur = Math.max(15, durationMins);
    const st = new Date(s.start);
    date = dayKey(st);
    startT = hm24(st);
    endT = hm24(new Date(st.getTime() + dur * 60_000));
    allDay = false;
  }

  function hm24(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function slotLabel(s: FreeSlot): string {
    const d = new Date(s.start);
    return `${dayLabel(d, calendar.now).slice(0, 3)} ${d.toLocaleDateString([], { day: "numeric", month: "short" })} · ${hm(s.start)}`;
  }

  async function save() {
    if (!subject.trim()) {
      subjectEl?.focus();
      return;
    }
    if (!allDay && endIso() <= startIso()) {
      toasts.error("End time must be after the start");
      return;
    }
    saving = true;
    const draft: EventDraft = {
      accountId,
      subject: subject.trim(),
      start: startIso(),
      end: endIso(),
      isAllDay: allDay,
      location: location.trim() || null,
      body: body.trim() || null,
      attendees,
      isOnline: online && attendees.length > 0,
    };
    try {
      const ev = await calendar.create(draft);
      calendar.closeComposer();
      if (app.view.kind === "agenda") calendar.openDetails(ev.id);
    } catch (e) {
      toasts.error(`Could not create event: ${errMsg(e)}`);
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
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => calendar.closeComposer()}>
    <div class="sheet" data-event-composer onclick={(e) => e.stopPropagation()} {onkeydown} role="dialog" aria-label="New event" tabindex="-1">
      <header>
        <CalIcon size={15} />
        <span class="t">New event</span>
        <span class="spacer"></span>
        <button class="icon-btn s" title="Close (Esc)" onclick={() => calendar.closeComposer()}><X size={14} /></button>
      </header>

      <input class="subject" bind:this={subjectEl} bind:value={subject} placeholder="Add a title" />

      {#if app.accounts.length > 1}
        <div class="row from">
          <span class="lbl">Calendar</span>
          <span class="fdot" style:background={hueColor(app.accountById.get(accountId)?.hue ?? 0, app.mode)}></span>
          <select bind:value={accountId}>
            {#each app.accounts as a (a.id)}<option value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>{/each}
          </select>
        </div>
      {/if}

      <div class="row when">
        <Clock size={14} />
        <input type="date" class="field" bind:value={date} />
        {#if !allDay}
          <input type="time" class="field" bind:value={startT} onchange={onStartChange} step="300" />
          <span class="dash">–</span>
          <input type="time" class="field" bind:value={endT} step="300" />
          <span class="dur mono">{durationMins >= 60 ? `${Math.floor(durationMins / 60)}h${durationMins % 60 ? ` ${durationMins % 60}m` : ""}` : `${durationMins}m`}</span>
        {/if}
        <label class="chk"><input type="checkbox" bind:checked={allDay} /> All day</label>
      </div>

      <div class="row people">
        <AddressInput label="Invite" bind:value={attendees} />
      </div>

      <div class="row opts">
        <label class="chk" class:off={!attendees.length} title={attendees.length ? "" : "Add attendees to create a Teams link"}>
          <input type="checkbox" bind:checked={online} disabled={!attendees.length} /><Video size={13} /> Teams meeting
        </label>
        <span class="loc"><MapPin size={13} /><input class="plain" bind:value={location} placeholder="Location" /></span>
      </div>

      <div class="find">
        <button class="btn sm" onclick={findTime} disabled={finding || allDay}>
          {#if finding}<LoaderCircle size={13} class="spin" />{:else}<Sparkles size={13} />{/if}
          Find a time{attendees.length ? ` with ${attendees.length} ${attendees.length === 1 ? "person" : "people"}` : ""}
        </button>
        <select class="range" bind:value={slotRange}>
          <option value={2}>next 2 days</option>
          <option value={7}>this week</option>
          <option value={14}>2 weeks</option>
        </select>
        {#if slots.length}
          <div class="slots">
            {#each slots as s (s.start)}
              <button class="slot" class:on={s.start === startIso()} onclick={() => useSlot(s)}>{slotLabel(s)}</button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="notes">
        <AlignLeft size={14} />
        <textarea bind:value={body} rows="3" placeholder="Agenda or notes (optional)"></textarea>
      </div>

      <footer>
        <button class="btn primary" onclick={save} disabled={saving}>
          {#if saving}<LoaderCircle size={14} class="spin" />{/if}
          {attendees.length ? "Send invitation" : "Save"} <kbd>^↵</kbd>
        </button>
        <button class="btn ghost" onclick={() => calendar.closeComposer()}>Cancel</button>
      </footer>
    </div>
  </div>
{/if}

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
    width: min(600px, calc(100vw - 40px));
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
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fg-dim);
    min-width: 0;
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
  .from select {
    font-size: 12.5px;
    color: var(--fg);
    background: transparent;
  }
  .when .field {
    height: 30px;
    padding: 0 8px;
    font-size: 12.5px;
    font-family: var(--font-mono);
    width: auto;
  }
  .when input[type="date"] {
    width: 150px;
  }
  .when input[type="time"] {
    width: 92px;
  }
  .dash {
    color: var(--muted);
  }
  .dur {
    font-size: 11px;
    color: var(--muted);
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
  .opts .chk {
    margin-left: 0;
  }
  .chk.off {
    opacity: 0.55;
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
