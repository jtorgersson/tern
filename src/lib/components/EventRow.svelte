<script lang="ts">
  // One calendar event in the Today timeline or the Agenda. Shared affordances: Join, respond, open.
  import { calendar } from "$lib/state/calendar.svelte";
  import { app } from "$lib/state/app.svelte";
  import type { CalEvent, InviteAction } from "$lib/types";
  import { hm, isNow, isPast, untilLabel, durationLabel } from "$lib/util/cal";
  import { hueColor } from "$lib/theme";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { Video, MapPin, Users, Check, CircleHelp, CircleAlert, Ban, Crown, ArrowRight } from "@lucide/svelte";

  let {
    ev,
    highlight = false,
    overlap = false,
    showAccount = false,
    dense = false,
  }: { ev: CalEvent; highlight?: boolean; overlap?: boolean; showAccount?: boolean; dense?: boolean } = $props();

  const now = $derived(calendar.now);
  const past = $derived(!ev.isAllDay && isPast(ev, now));
  const live = $derived(!ev.isAllDay && isNow(ev, now));
  const canRespond = $derived(ev.response !== "organizer" && !ev.isCancelled && !past && ev.organizer != null);
  const needsResponse = $derived(canRespond && ev.response === "notResponded");
  const acct = $derived(app.accountById.get(ev.accountId));
  const others = $derived(ev.attendees.filter((a) => a.type !== "resource").length);
  const selected = $derived(calendar.selectedId === ev.id);
  let busy = $state<InviteAction | null>(null);

  async function respond(action: InviteAction, e: Event) {
    e.stopPropagation();
    busy = action;
    try {
      await calendar.respond(ev, action);
    } catch {
      /* toast shown by store */
    } finally {
      busy = null;
    }
  }

  function join(e: Event) {
    e.stopPropagation();
    if (ev.joinUrl) openUrl(ev.joinUrl);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="ev"
  class:past
  class:live
  class:highlight
  class:cancelled={ev.isCancelled}
  class:declined={ev.response === "declined"}
  class:selected
  class:dense
  class:allday={ev.isAllDay}
  data-event-id={ev.id}
  onclick={() => calendar.openDetails(ev.id)}
  role="button"
  tabindex="-1">
  <div class="time mono">
    {#if ev.isAllDay}
      <span class="t1">all day</span>
    {:else}
      <span class="t1">{hm(ev.start)}</span>
      <span class="t2">{hm(ev.end)}</span>
    {/if}
  </div>
  <span class="bar" style:background={showAccount && acct ? hueColor(acct.hue, app.mode) : undefined}></span>
  <div class="main">
    <div class="l1">
      <span class="title">{ev.subject || "(no title)"}</span>
      {#if live}<span class="pill live">Now</span>{:else if highlight}<span class="pill soon">{untilLabel(ev, now)}</span>{/if}
      {#if ev.isCancelled}<span class="pill warn">Cancelled</span>{/if}
      {#if overlap && !ev.isCancelled}<span class="pill warn" title="Overlaps another meeting">overlaps</span>{/if}
      <span class="spacer"></span>
      {#if ev.response === "organizer"}
        <span class="st org" title="You're the organizer"><Crown size={11} /></span>
      {:else if ev.response === "accepted"}
        <span class="st ok" title="Accepted"><Check size={12} strokeWidth={2.6} /></span>
      {:else if ev.response === "tentativelyAccepted"}
        <span class="st maybe" title="Tentative"><CircleHelp size={12} /></span>
      {:else if ev.response === "declined"}
        <span class="st no" title="Declined"><Ban size={12} /></span>
      {:else if ev.response === "notResponded"}
        <span class="st ask" title="You haven't responded"><CircleAlert size={12} /></span>
      {/if}
    </div>
    <div class="l2">
      {#if !ev.isAllDay}<span class="dur">{durationLabel(ev.start, ev.end)}</span>{/if}
      {#if ev.isOnline}
        <span class="meta teams"><Video size={11} /> Teams</span>
      {:else if ev.location}
        <span class="meta"><MapPin size={11} /> <span class="loc">{ev.location}</span></span>
      {/if}
      {#if others}
        <span class="meta"><Users size={11} /> {others}</span>
      {/if}
      {#if ev.organizer && ev.response !== "organizer" && !dense}
        <span class="meta org-name">· {ev.organizer.name || ev.organizer.email}</span>
      {/if}
    </div>
    {#if needsResponse}
      <div class="respond">
        <button class="rbtn yes" disabled={!!busy} onclick={(e) => respond("accept", e)}><Check size={12} /> Accept</button>
        <button class="rbtn" disabled={!!busy} onclick={(e) => respond("tentativelyAccept", e)}>Tentative</button>
        <button class="rbtn no" disabled={!!busy} onclick={(e) => respond("decline", e)}>Decline</button>
      </div>
    {/if}
  </div>
  <div class="actions">
    {#if ev.joinUrl && !past && !ev.isCancelled && ev.response !== "declined"}
      <button class="btn sm join" class:primary={highlight || live} onclick={join}><Video size={13} /> Join</button>
    {/if}
    <span class="open"><ArrowRight size={13} /></span>
  </div>
</div>

<style>
  .ev {
    position: relative;
    display: grid;
    grid-template-columns: 68px 3px minmax(0, 1fr) auto;
    gap: 0 12px;
    align-items: start;
    padding: 10px 12px 10px 10px;
    border-radius: 12px;
    cursor: default;
    transition: background var(--t), box-shadow var(--t), opacity var(--t);
  }
  .ev.dense {
    padding: 8px 10px 8px 8px;
  }
  .ev:hover {
    background: var(--hover);
  }
  .ev.selected {
    box-shadow: inset 0 0 0 1px var(--accent-line);
    background: color-mix(in oklab, var(--accent) 7%, transparent);
  }
  .ev.highlight {
    background: linear-gradient(90deg, color-mix(in oklab, var(--accent) 12%, transparent), transparent 70%);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 28%, var(--line));
  }
  .ev.live {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--green) 40%, var(--line));
  }
  .ev.past {
    opacity: 0.5;
  }
  .ev.past:hover {
    opacity: 0.8;
  }
  .ev.cancelled .title,
  .ev.declined .title {
    text-decoration: line-through;
    color: var(--muted);
  }
  .time {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 11px;
    color: var(--fg-dim);
    padding-top: 1px;
    text-align: right;
    white-space: nowrap;
    letter-spacing: -0.02em;
  }
  .t2 {
    color: var(--muted);
    font-size: 10.5px;
  }
  .allday .t1 {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .bar {
    align-self: stretch;
    border-radius: 3px;
    background: color-mix(in oklab, var(--accent) 60%, transparent);
    min-height: 30px;
  }
  .live .bar {
    background: var(--green);
  }
  .cancelled .bar,
  .declined .bar {
    background: var(--line-strong);
  }
  .main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .l1 {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--fg-bright);
    letter-spacing: -0.005em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .pill {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    letter-spacing: 0.02em;
  }
  .pill.soon {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .pill.live {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 16%, transparent);
  }
  .pill.warn {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 14%, transparent);
  }
  .st {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    flex: none;
  }
  .st.ok {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 16%, transparent);
  }
  .st.maybe {
    color: var(--yellow);
  }
  .st.no {
    color: var(--muted);
  }
  .st.ask {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 14%, transparent);
  }
  .st.org {
    color: var(--accent);
  }
  .l2 {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11.5px;
    color: var(--muted);
    min-width: 0;
  }
  .dur {
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .meta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .meta.teams {
    color: color-mix(in oklab, var(--blue) 80%, var(--fg));
  }
  .loc,
  .org-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 260px;
  }
  .respond {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .rbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border-radius: 7px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--fg-dim);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: all var(--t);
  }
  .rbtn:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .rbtn.yes {
    color: var(--green);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--green) 40%, transparent);
  }
  .rbtn.yes:hover {
    background: color-mix(in oklab, var(--green) 14%, transparent);
  }
  .rbtn.no:hover {
    color: var(--red);
  }
  .rbtn:disabled {
    opacity: 0.5;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: center;
  }
  .open {
    display: grid;
    color: var(--muted);
    opacity: 0;
    transition: opacity var(--t);
  }
  .ev:hover .open {
    opacity: 1;
  }
  .join {
    gap: 5px;
  }
</style>
