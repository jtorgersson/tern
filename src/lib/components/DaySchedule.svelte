<script lang="ts">
  // "Your day" on Today: today's events as a timeline with a now-marker and the next meeting highlighted.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { toLocalIso, isPast, hm } from "$lib/util/cal";
  import EventRow from "./EventRow.svelte";
  import { CalendarDays, ArrowRight, Plus } from "@lucide/svelte";

  const events = $derived(calendar.todayEvents);
  const allDay = $derived(events.filter((e) => e.isAllDay));
  const timed = $derived(events.filter((e) => !e.isAllDay));
  const nowIso = $derived(toLocalIso(calendar.now));
  const nextId = $derived(calendar.nextUp?.id ?? null);
  const overlapIds = $derived(calendar.overlapIds(events));
  // The now-marker sits before the first event that hasn't started yet.
  const nowIndex = $derived.by(() => {
    const i = timed.findIndex((e) => e.start > nowIso);
    return i < 0 ? timed.length : i;
  });
  const showNow = $derived(timed.length > 0 && timed.some((e) => !isPast(e, calendar.now)));
  const showAccount = $derived(!app.accountFilter && app.accounts.length > 1);
</script>

<section class="day">
  <div class="group-head">
    <CalendarDays size={14} />
    <h2>Your day</h2>
    {#if calendar.todayMeetings.length}<span class="n">{calendar.todayMeetings.length}</span>{/if}
    <span class="spacer"></span>
    <button class="mini" onclick={() => calendar.openComposer()}><Plus size={12} /> New event</button>
    <button class="mini" onclick={() => app.setView({ kind: "calendar" })}>Calendar <ArrowRight size={12} /></button>
  </div>

  <div class="card">
    {#if !calendar.loadedOnce && calendar.loading}
      <div class="skeleton"><span style:width="60%"></span><span style:width="80%"></span></div>
    {:else if !events.length}
      <div class="calm">No meetings today.</div>
    {:else}
      {#if allDay.length}
        <div class="allday">
          {#each allDay as e (e.id)}
            <button class="adchip" class:cancelled={e.isCancelled} onclick={() => calendar.openDetails(e.id)} title={e.subject}>{e.subject || "(no title)"}</button>
          {/each}
        </div>
      {/if}
      <div class="list">
        {#each timed as e, i (e.id)}
          {#if showNow && i === nowIndex}
            <div class="now" aria-label="Now"><span class="dot"></span><span class="line"></span><span class="lbl mono">{hm(calendar.now)}</span></div>
          {/if}
          <EventRow ev={e} highlight={e.id === nextId} overlap={overlapIds.has(e.id)} {showAccount} />
        {/each}
        {#if showNow && nowIndex === timed.length}
          <div class="now end" aria-label="Now"><span class="dot"></span><span class="line"></span><span class="lbl mono">{hm(calendar.now)}</span></div>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .day {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px;
    color: var(--fg-dim);
  }
  .group-head h2 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--fg-bright);
  }
  .n {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
  }
  .spacer {
    flex: 1;
  }
  .mini {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--fg-dim);
    padding: 3px 8px;
    border-radius: 6px;
    transition: all var(--t);
  }
  .mini:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .card {
    padding: 8px;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    animation: fade-up 240ms var(--ease) both;
  }
  .calm {
    padding: 10px 12px;
    font-size: 13px;
    color: var(--fg-dim);
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 10px 12px;
  }
  .skeleton span {
    height: 11px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--hover) 25%, color-mix(in oklab, var(--accent) 14%, transparent) 50%, var(--hover) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }
  .allday {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 4px 8px;
  }
  .adchip {
    max-width: 320px;
    height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 550;
    color: var(--fg);
    background: color-mix(in oklab, var(--blue) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--blue) 30%, transparent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: all var(--t);
  }
  .adchip:hover {
    background: color-mix(in oklab, var(--blue) 22%, transparent);
  }
  .adchip.cancelled {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .now {
    display: grid;
    grid-template-columns: 68px 1fr auto;
    align-items: center;
    gap: 0 8px;
    height: 14px;
    padding: 0 10px 0 10px;
    margin: 2px 0;
  }
  .now .dot {
    justify-self: end;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--red) 25%, transparent);
  }
  .now .line {
    height: 1px;
    background: linear-gradient(90deg, var(--red), color-mix(in oklab, var(--red) 20%, transparent));
  }
  .now .lbl {
    font-size: 10px;
    color: var(--red);
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .skeleton span {
      animation: none;
    }
  }
</style>
