<script lang="ts">
  // Event details popover: when / where / who, response tally, full description, respond, edit, move, delete.
  import { calendar } from "$lib/state/calendar.svelte";
  import { app } from "$lib/state/app.svelte";
  import { agent } from "$lib/state/agent.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import type { EditScope, InviteAction } from "$lib/types";
  import { whenLabel, untilLabel, isPast, initialsOf, RESPONSE_LABEL, recurrenceLabel, SHOW_AS_LABEL, hm } from "$lib/util/cal";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { X, Video, MapPin, ExternalLink, Check, CircleHelp, Ban, Crown, CircleAlert, Sparkles, AlertTriangle, Pencil, Trash2, Copy, Repeat, Bell, Lock, LockOpen, Mail, Link as LinkIcon, CalendarClock } from "@lucide/svelte";
  import MeetingPrep from "./MeetingPrep.svelte";
  import { followUpFromNotes, textToHtml, isAbort } from "$lib/ai";
  import { api } from "$lib/api";
  import { hhmmIn, tzLabel, dayShiftIn } from "$lib/util/fmt";
  import { toasts } from "$lib/state/toasts.svelte";
  import { errMsg } from "$lib/util/misc";
  import { NotebookPen, Send as SendIcon, LoaderCircle, Clock3, CalendarArrowUp, CalendarPlus2, Globe } from "@lucide/svelte";
  import ProposeTime from "./ProposeTime.svelte";

  const ev = $derived(calendar.details);
  const full = $derived(calendar.detailsFull?.event.id === ev?.id ? calendar.detailsFull : null);
  const acct = $derived(ev ? app.accountById.get(ev.accountId) : undefined);
  const cal = $derived(ev ? calendar.calendarById.get(ev.calendarId) : undefined);
  const conflicts = $derived(ev ? calendar.conflictsFor(ev) : []);
  const past = $derived(ev ? isPast(ev, calendar.now) : false);
  const canRespond = $derived(!!ev && ev.response !== "organizer" && !ev.isCancelled && !past && ev.organizer != null);
  const canEdit = $derived(!!ev && !ev.isCancelled && (cal?.canEdit ?? true));
  const isOrganizer = $derived(!!ev && (ev.response === "organizer" || ev.attendees.length === 0));
  let busy = $state<InviteAction | null>(null);
  let note = $state("");
  let showNote = $state(false);
  let sendResponse = $state(true);
  let confirmDelete = $state<null | { scope: EditScope }>(null);
  let cancelNote = $state("");
  let proposing = $state(false);
  const isPrivate = $derived(ev?.sensitivity === "private");
  const canMove = $derived(!!ev && calendar.canChangeTime(ev));
  const tz2 = $derived(app.settings?.calendar.secondaryTimeZone ?? null);

  // ---- notes (local, autosaved) ----
  let notes = $state("");
  let notesOpen = $state(false);
  let notesLoadedFor = "";
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let following = $state(false);
  $effect(() => {
    const id = ev?.id;
    if (!id || id === notesLoadedFor) return;
    notesLoadedFor = id;
    notes = "";
    notesOpen = false;
    api.eventNoteGet(id).then((t) => {
      if (notesLoadedFor !== id) return;
      notes = t ?? "";
      notesOpen = !!t;
    });
  });
  function onNotesInput() {
    const id = ev?.id;
    if (!id) return;
    clearTimeout(saveTimer);
    const text = notes;
    saveTimer = setTimeout(() => calendar.saveNote(id, text).catch((e) => toasts.error(`Notes: ${errMsg(e)}`)), 500);
  }
  /** Follow-up email to everyone, drafted from the notes (AI when available). */
  async function followUp() {
    if (!ev || !notes.trim()) return;
    // The popover can close or switch event while the draft streams; work on a snapshot.
    const e0 = ev;
    const text = notes;
    const me = new Set(app.ownAccounts.map((a) => a.email.toLowerCase()));
    const to = [...(e0.organizer ? [e0.organizer] : []), ...e0.attendees.filter((a) => a.type !== "resource").map((a) => a.addr)].filter(
      (a, i, arr) => !me.has(a.email.toLowerCase()) && arr.findIndex((b) => b.email.toLowerCase() === a.email.toLowerCase()) === i,
    );
    let body = text.trim();
    if (app.aiReady) {
      following = true;
      try {
        let acc = "";
        for await (const d of followUpFromNotes(e0, text)) acc += d;
        if (acc.trim()) body = acc.trim();
      } catch (e) {
        if (!isAbort(e)) toasts.error(`AI: ${errMsg(e)} — using your notes as they are`);
      } finally {
        following = false;
      }
    }
    composer.compose({ accountId: e0.accountId, to, subject: `Follow-up: ${e0.subject}`, bodyHtml: textToHtml(body) });
    if (calendar.detailsId === e0.id) calendar.openDetails(null);
  }

  $effect(() => {
    void ev?.id;
    note = "";
    showNote = false;
    sendResponse = true;
    confirmDelete = null;
    cancelNote = "";
    proposing = false;
  });
  let seenDeleteRequest = 0;
  $effect(() => {
    const n = calendar.deleteRequest;
    if (n === seenDeleteRequest) return;
    seenDeleteRequest = n;
    if (ev && canEdit) confirmDelete = { scope: "occurrence" };
  });

  async function respond(action: InviteAction) {
    if (!ev) return;
    busy = action;
    try {
      await calendar.respond(ev, action, note.trim() || null, sendResponse);
    } catch {
      /* toast */
    } finally {
      busy = null;
    }
  }

  const counts = $derived.by(() => {
    const c = { accepted: 0, tentativelyAccepted: 0, declined: 0, notResponded: 0 };
    for (const a of ev?.attendees ?? []) if (a.response in c) c[a.response as keyof typeof c]++;
    return c;
  });

  function ask() {
    if (!ev) return;
    app.toggleAgent(true);
    agent.send(`What is my meeting "${ev.subject}" (${whenLabel(ev)}) about? Check related mail and tell me what I should prepare.`);
  }
  function emailAttendees() {
    if (!ev) return;
    const me = acct?.email.toLowerCase();
    const to = [...(ev.organizer ? [ev.organizer] : []), ...ev.attendees.map((a) => a.addr)].filter((a, i, arr) => a.email.toLowerCase() !== me && arr.findIndex((b) => b.email.toLowerCase() === a.email.toLowerCase()) === i);
    composer.compose({ accountId: ev.accountId, to, subject: ev.subject });
    calendar.openDetails(null);
  }
  async function copyLink() {
    if (!ev?.joinUrl) return;
    try {
      await navigator.clipboard.writeText(ev.joinUrl);
    } catch {}
  }
  async function doDelete() {
    if (!ev || !confirmDelete) return;
    try {
      await calendar.remove(ev, confirmDelete.scope, cancelNote.trim() || null);
    } catch {
      /* toast */
    }
  }
  const description = $derived((full?.bodyText ?? ev?.preview ?? "").trim());
  const recurrence = $derived(full ? recurrenceLabel(full.recurrence) : ev?.seriesMasterId ? "Repeats" : "");
</script>

{#if ev}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => calendar.openDetails(null)}>
    <div class="pop" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Event details" tabindex="-1" style:--c={calendar.colorOf(ev)}>
      <header>
        <div class="when">
          <span class="eyebrow">{whenLabel(ev)}</span>
          {#if !past && !ev.isCancelled}<span class="until mono">{untilLabel(ev, calendar.now)}</span>{/if}
        </div>
        <div class="hdr-actions">
          {#if canEdit}
            <button class="icon-btn s" class:on={isPrivate} onclick={() => calendar.togglePrivate(ev)} title={isPrivate ? "Private — click to make visible to people who can see your calendar" : "Make private (hidden from people who can see your calendar)"}>
              {#if isPrivate}<Lock size={14} />{:else}<LockOpen size={14} />{/if}
            </button>
            <button class="icon-btn s" onclick={() => calendar.openEditor(ev, "occurrence")} title="Edit (e)"><Pencil size={14} /></button>
            <button class="icon-btn s" onclick={() => calendar.duplicate(ev)} title="Duplicate"><Copy size={14} /></button>
            <button class="icon-btn s danger" onclick={() => (confirmDelete = confirmDelete ? null : { scope: "occurrence" })} title="Delete (#)"><Trash2 size={14} /></button>
          {/if}
          <button class="icon-btn s" onclick={() => calendar.openDetails(null)} aria-label="Close"><X size={15} /></button>
        </div>
      </header>
      <h2 class:strike={ev.isCancelled || ev.response === "declined"}>{ev.subject || "(no title)"}</h2>
      <div class="badges">
        {#if ev.isCancelled}<span class="pill warn">Cancelled</span>{/if}
        {#if ev.response === "organizer"}<span class="pill acc"><Crown size={11} /> You organize</span>
        {:else if ev.response === "accepted"}<span class="pill ok"><Check size={11} /> Accepted</span>
        {:else if ev.response === "tentativelyAccepted"}<span class="pill maybe"><CircleHelp size={11} /> Tentative</span>
        {:else if ev.response === "declined"}<span class="pill"><Ban size={11} /> Declined</span>
        {:else if ev.response === "notResponded"}<span class="pill warn"><CircleAlert size={11} /> Not responded</span>{/if}
        {#if ev.showAs !== "busy" && SHOW_AS_LABEL[ev.showAs]}<span class="pill">{SHOW_AS_LABEL[ev.showAs]}</span>{/if}
        {#if ev.sensitivity === "private"}<span class="pill"><Lock size={10} /> Private</span>{/if}
        {#if cal || (acct && app.accounts.length > 1)}
          <span class="pill acct"><span class="dot"></span>{cal?.name ?? "Calendar"}{acct && app.accounts.length > 1 ? ` · ${acct.email}` : ""}</span>
        {/if}
      </div>

      {#if confirmDelete}
        <div class="confirm">
          <div class="ct">
            {#if isOrganizer && ev.attendees.length}Cancel this meeting and notify {ev.attendees.length} attendee{ev.attendees.length === 1 ? "" : "s"}?{:else}Remove this event from your calendar?{/if}
          </div>
          {#if ev.seriesMasterId}
            <div class="seg">
              <button class:on={confirmDelete.scope === "occurrence"} onclick={() => (confirmDelete = { scope: "occurrence" })}>Only this one</button>
              <button class:on={confirmDelete.scope === "series"} onclick={() => (confirmDelete = { scope: "series" })}>Whole series</button>
            </div>
          {/if}
          {#if isOrganizer && ev.attendees.length}
            <input class="field" bind:value={cancelNote} placeholder="Message to attendees (optional)" />
          {/if}
          <div class="cb">
            <button class="btn danger" onclick={doDelete}><Trash2 size={13} /> {isOrganizer && ev.attendees.length ? "Cancel meeting" : "Delete"}</button>
            <button class="btn ghost" onclick={() => (confirmDelete = null)}>Keep</button>
          </div>
        </div>
      {/if}

      {#if conflicts.length && !ev.isCancelled && ev.response !== "declined"}
        <div class="conflict">
          <AlertTriangle size={13} />
          <div>
            {#each conflicts as c (c.id)}
              <div>Overlaps with <button class="lnk" onclick={() => calendar.openDetails(c.id)}><b>{c.subject || "(no title)"}</b></button> <span class="mono">{hm(c.start)}–{hm(c.end)}</span></div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="rows">
        {#if ev.isOnline && ev.joinUrl}
          <div class="joinrow">
            <button class="btn primary join" onclick={() => openUrl(ev.joinUrl!)} disabled={past || ev.isCancelled}><Video size={14} /> Join Teams meeting</button>
            <button class="icon-btn s" onclick={copyLink} title="Copy link"><LinkIcon size={13} /></button>
          </div>
        {/if}
        {#if ev.location}
          <div class="row"><MapPin size={14} /><span>{ev.location}</span></div>
        {/if}
        {#if recurrence}
          <div class="row"><Repeat size={14} /><span>{recurrence}</span>
            {#if canEdit && ev.seriesMasterId}<button class="lnk small" onclick={() => calendar.openEditor(ev, "series")}>Edit series</button>{/if}
          </div>
        {/if}
        {#if ev.reminderMinutes != null}
          <div class="row"><Bell size={14} /><span>{ev.reminderMinutes === 0 ? "Reminder at start" : ev.reminderMinutes < 60 ? `Reminder ${ev.reminderMinutes} min before` : `Reminder ${ev.reminderMinutes / 60} h before`}</span></div>
        {/if}
        {#if ev.organizer && ev.response !== "organizer"}
          <div class="row"><Crown size={14} /><span>Organized by <b>{ev.organizer.name || ev.organizer.email}</b></span></div>
        {/if}
        {#if ev.categories.length}
          <div class="row cats">{#each ev.categories as c (c)}<span class="cat">{c}</span>{/each}</div>
        {/if}
      </div>

      {#if ev.attendees.length}
        <div class="att-head">
          <span class="eyebrow">{ev.attendees.length} attendee{ev.attendees.length === 1 ? "" : "s"}</span>
          <span class="tally mono">
            {#if counts.accepted}<span class="ok">{counts.accepted} ✓</span>{/if}
            {#if counts.tentativelyAccepted}<span class="maybe">{counts.tentativelyAccepted} ?</span>{/if}
            {#if counts.declined}<span class="no">{counts.declined} ✕</span>{/if}
            {#if counts.notResponded}<span class="muted">{counts.notResponded} –</span>{/if}
          </span>
        </div>
        <ul class="attendees">
          {#each ev.attendees as a (a.addr.email)}
            <li>
              <span class="av" class:optional={a.type === "optional"}>{initialsOf(a.addr.name, a.addr.email)}</span>
              <span class="an" title={a.addr.email}>{a.addr.name || a.addr.email}</span>
              {#if a.type === "optional"}<span class="opt">optional</span>{/if}
              <span class="spacer"></span>
              <span class="resp {a.response}" title={RESPONSE_LABEL[a.response]}>
                {#if a.response === "accepted"}<Check size={12} strokeWidth={2.6} />{:else if a.response === "tentativelyAccepted"}<CircleHelp size={12} />{:else if a.response === "declined"}<Ban size={12} />{:else if a.response === "organizer"}<Crown size={11} />{:else}<span class="dash">–</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if description}
        <p class="preview" class:full={!!full}>{description}</p>
      {/if}

      {#if tz2 && !ev.isAllDay}
        <div class="row tz2"><Globe size={14} /><span><b class="mono">{hhmmIn(ev.start, tz2)}–{hhmmIn(ev.end, tz2)}</b> {tzLabel(tz2)}{#if dayShiftIn(ev.start, tz2) !== 0}<span class="shift"> ({dayShiftIn(ev.start, tz2) > 0 ? "next day" : "previous day"})</span>{/if}</span></div>
      {/if}

      {#if canMove && !past}
        <div class="resched" aria-label="Quick reschedule">
          <span class="rl"><Clock3 size={12} /> Move</span>
          {#if !ev.isAllDay}<button class="chip" onclick={() => calendar.reschedule(ev, "later")} title="One hour later">+1 h</button>{/if}
          <button class="chip" onclick={() => calendar.reschedule(ev, "tomorrow")} title="Same time tomorrow (])"><CalendarArrowUp size={12} /> Tomorrow</button>
          <button class="chip" onclick={() => calendar.reschedule(ev, "nextWeek")} title="Same time next week"><CalendarPlus2 size={12} /> Next week</button>
        </div>
      {/if}

      {#if !ev.isCancelled && !past && (ev.attendees.length || ev.organizer)}
        <MeetingPrep {ev} />
      {/if}

      <div class="notes" class:open={notesOpen}>
        {#if notesOpen}
          <div class="nh"><NotebookPen size={13} /> <span>Notes</span><span class="nhint">private to Tern · saved automatically</span></div>
          <textarea bind:value={notes} oninput={onNotesInput} rows="4" placeholder="Decisions, action items, who does what…"></textarea>
          {#if notes.trim() && (ev.attendees.length || (ev.organizer && ev.response !== "organizer"))}
            <button class="btn sm" onclick={followUp} disabled={following}>
              {#if following}<LoaderCircle size={12} class="spin" /> Writing…{:else}<SendIcon size={12} /> {app.aiReady ? "Draft follow-up email" : "Email notes to attendees"}{/if}
            </button>
          {/if}
        {:else}
          <button class="lnk small addnotes" onclick={() => (notesOpen = true)}><NotebookPen size={12} /> Add meeting notes</button>
        {/if}
      </div>

      {#if proposing}
        <ProposeTime {ev} onclose={() => (proposing = false)} />
      {/if}

      {#if canRespond}
        <div class="respond">
          <div class="rbtns">
            <button class="btn" class:on={ev.response === "accepted"} disabled={!!busy} onclick={() => respond("accept")}><Check size={13} /> Accept</button>
            <button class="btn" class:on={ev.response === "tentativelyAccepted"} disabled={!!busy} onclick={() => respond("tentativelyAccept")}><CircleHelp size={13} /> Tentative</button>
            <button class="btn" class:on={ev.response === "declined"} disabled={!!busy} onclick={() => respond("decline")}><Ban size={13} /> Decline</button>
            <span class="spacer"></span>
            {#if !showNote}<button class="lnk small" onclick={() => (showNote = true)}>Add a note</button>{/if}
            <button class="lnk small" onclick={() => (proposing = !proposing)}><CalendarClock size={12} /> New time</button>
          </div>
          {#if showNote}
            <input class="field" bind:value={note} placeholder="Note to the organizer (optional)" />
          {/if}
          <label class="send"><input type="checkbox" checked={!sendResponse} onchange={(e) => (sendResponse = !(e.currentTarget as HTMLInputElement).checked)} /> Don't send a response</label>
        </div>
      {/if}

      <footer>
        {#if app.aiReady}<button class="mini" onclick={ask}><Sparkles size={12} /> Prep me</button>{/if}
        {#if ev.attendees.length || (ev.organizer && ev.response !== "organizer")}<button class="mini" onclick={emailAttendees}><Mail size={12} /> Email {ev.response === "organizer" ? "attendees" : "everyone"}</button>{/if}
        <span class="spacer"></span>
        {#if ev.webLink}<button class="mini" onclick={() => openUrl(ev.webLink!)}>Outlook <ExternalLink size={12} /></button>{/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 48;
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
  .pop {
    width: min(540px, calc(100vw - 40px));
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    padding: 16px 18px 14px;
    border-radius: 16px;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: var(--shadow);
    border-top: 3px solid var(--c);
    animation: fade-up 180ms var(--ease);
    display: flex;
    flex-direction: column;
    gap: 12px;
    user-select: text;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .when {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .hdr-actions {
    display: flex;
    gap: 2px;
  }
  .icon-btn.danger:hover {
    color: var(--red);
  }
  .until {
    font-size: 10.5px;
    color: var(--accent);
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
  }
  h2 {
    margin: -4px 0 0;
    font-size: 19px;
    font-weight: 680;
    letter-spacing: -0.02em;
    line-height: 1.25;
    color: var(--fg-bright);
  }
  h2.strike {
    text-decoration: line-through;
    color: var(--muted);
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: -4px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 11px;
    color: var(--fg-dim);
    background: var(--hover);
  }
  .pill.ok {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 16%, transparent);
  }
  .pill.maybe {
    color: var(--yellow);
    background: color-mix(in oklab, var(--yellow) 16%, transparent);
  }
  .pill.warn {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 14%, transparent);
  }
  .pill.acc {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .pill.acct .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c);
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--red) 8%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--red) 30%, transparent);
  }
  .ct {
    font-size: 13px;
    color: var(--fg-bright);
    font-weight: 550;
  }
  .seg {
    display: inline-flex;
    align-self: flex-start;
    padding: 2px;
    border-radius: 8px;
    background: var(--hover);
  }
  .seg button {
    height: 24px;
    padding: 0 10px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--fg-dim);
  }
  .seg button.on {
    color: var(--fg-bright);
    background: var(--raised);
    box-shadow: var(--shadow-sm);
  }
  .cb {
    display: flex;
    gap: 6px;
  }
  .confirm .field {
    height: 30px;
    font-size: 12.5px;
  }
  .conflict {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 10px;
    border-radius: 10px;
    font-size: 12.5px;
    color: var(--red);
    background: color-mix(in oklab, var(--red) 10%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--red) 30%, transparent);
  }
  .conflict b {
    color: var(--fg-bright);
    font-weight: 600;
  }
  .conflict .mono {
    font-size: 11px;
    opacity: 0.85;
  }
  .lnk {
    color: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .lnk.small {
    font-size: 12px;
    color: var(--accent);
    text-decoration: none;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 13px;
    color: var(--fg-dim);
  }
  .row b {
    color: var(--fg);
    font-weight: 600;
  }
  .joinrow {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .cats {
    flex-wrap: wrap;
    gap: 5px;
  }
  .cat {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--hover);
  }
  .att-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: -6px;
  }
  .tally {
    display: flex;
    gap: 8px;
    font-size: 10.5px;
  }
  .tally .ok {
    color: var(--green);
  }
  .tally .maybe {
    color: var(--yellow);
  }
  .tally .no {
    color: var(--red);
  }
  .tally .muted {
    color: var(--muted);
  }
  .attendees {
    list-style: none;
    margin: 0;
    padding: 4px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    max-height: 220px;
    overflow-y: auto;
  }
  .attendees li {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 8px;
    border-radius: 8px;
    font-size: 12.5px;
  }
  .attendees li:hover {
    background: var(--hover);
  }
  .av {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    font-size: 9.5px;
    font-weight: 650;
    color: var(--fg);
    background: color-mix(in oklab, var(--accent) 22%, transparent);
  }
  .av.optional {
    opacity: 0.7;
  }
  .an {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opt {
    font-size: 10px;
    color: var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .resp {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: var(--muted);
  }
  .resp.accepted {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 16%, transparent);
  }
  .resp.tentativelyAccepted {
    color: var(--yellow);
  }
  .resp.declined {
    color: var(--red);
  }
  .resp.organizer {
    color: var(--accent);
  }
  .dash {
    font-size: 11px;
  }
  .tz2 .shift {
    color: var(--muted);
    font-size: 12px;
  }
  .tz2 b {
    font-weight: 600;
    color: var(--fg);
  }
  .resched {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rl {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--muted);
    margin-right: 2px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 11.5px;
    color: var(--fg);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: all var(--t);
  }
  .chip:hover {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .notes.open {
    padding: 10px 12px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--yellow) 6%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--yellow) 22%, var(--line));
  }
  .nh {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: color-mix(in oklab, var(--yellow) 85%, var(--fg));
  }
  .nhint {
    margin-left: auto;
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    color: var(--muted);
  }
  .notes textarea {
    width: 100%;
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg);
    background: transparent;
    border: 0;
    outline: 0;
    resize: vertical;
    min-height: 70px;
  }
  .notes .btn {
    align-self: flex-start;
  }
  .addnotes {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
  }
  .preview {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--fg-dim);
    white-space: pre-wrap;
    max-height: 120px;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, black 70%, transparent);
  }
  .preview.full {
    max-height: 260px;
    overflow-y: auto;
    mask-image: none;
    padding-right: 4px;
  }
  .respond {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--line);
  }
  .rbtns {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .rbtns .btn.on {
    box-shadow: inset 0 0 0 1px var(--accent-line);
    background: var(--accent-soft);
  }
  .send {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--muted);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 -8px -4px;
  }
  .mini {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--fg-dim);
    padding: 4px 8px;
    border-radius: 6px;
  }
  .mini:hover {
    color: var(--fg);
    background: var(--hover);
  }
</style>
