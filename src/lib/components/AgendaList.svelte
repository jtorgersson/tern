<script lang="ts">
  // Agenda: the period (two weeks from the anchor) as a list, with free-gap hints inside working hours.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { dayLabel, dateLabel, freeGaps, hm, isPast, dayKey, type Gap } from "$lib/util/cal";
  import { isoWeek } from "$lib/util/fmt";
  import EventRow from "./EventRow.svelte";
  import Logo from "./Logo.svelte";
  import { Plus } from "@lucide/svelte";

  const days = $derived(calendar.byDay());
  const total = $derived(days.reduce((n, d) => n + d.events.length, 0));
  const showAccount = $derived(!app.accountFilter && app.accounts.length > 1);
  const ws = $derived(app.settings?.calendar?.workStart ?? "09:00");
  const we = $derived(app.settings?.calendar?.workEnd ?? "17:00");
  const todayKey = $derived(dayKey(calendar.now));
  const nextId = $derived(calendar.nextUp?.id ?? null);

  function gapLabel(mins: number): string {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h ? `${h}h` : ""}${h && m ? " " : ""}${m ? `${m}m` : ""} free`;
  }

  /** Gaps shown between rows: id of the timed event the gap precedes → gap; "end" for a trailing gap. */
  function gapMap(dayEvents: typeof days[number]["events"], day: Date) {
    const map = new Map<string, Gap>();
    if (day.getDay() === 0 || day.getDay() === 6) return map;
    const timed = dayEvents.filter((e) => !e.isAllDay);
    for (const g of freeGaps(dayEvents, day, ws, we, 60)) {
      if (dayKey(day) === todayKey && isPast({ end: g.end }, calendar.now)) continue;
      const next = timed.find((e) => e.start >= g.end);
      map.set(next ? next.id : "end", g);
    }
    return map;
  }
  const weekStartKeys = $derived(new Set(days.filter(({ day }) => day.getDay() === 1).map(({ day }) => dayKey(day))));
</script>

<div class="scroll">
  <div class="canvas">
    {#if calendar.loadedOnce && !total}
      <div class="empty">
        <div class="mark"><Logo size={40} /></div>
        <h2>A clear fortnight</h2>
        <p>Nothing on the calendar in this period.</p>
        <button class="btn" onclick={() => calendar.openComposer()}><Plus size={14} /> New event</button>
      </div>
    {/if}

    {#each days as { day, events }, di (dayKey(day))}
      {@const key = dayKey(day)}
      {@const isToday = key === todayKey}
      {@const gaps = gapMap(events, day)}
      {@const overlapIds = calendar.overlapIds(events)}
      {@const allDay = events.filter((e) => e.isAllDay)}
      {@const timed = events.filter((e) => !e.isAllDay)}
      {#if weekStartKeys.has(key) && calendar.showWeekNumbers && di > 0}
        <div class="wksep"><span class="mono">week {isoWeek(day)}</span></div>
      {/if}
      {#if events.length || isToday}
        <section class="dayblock" class:today={isToday} style:--i={di}>
          <button class="dayhead" onclick={() => calendar.goto(day, "day")}>
            <span class="dow" class:accent={isToday}>{dayLabel(day, calendar.now)}</span>
            <span class="date mono">{dateLabel(day)}</span>
            {#if isToday && !events.length}<span class="muted">— nothing scheduled</span>{/if}
          </button>
          {#if events.length}
            <div class="card">
              {#if allDay.length}
                <div class="allday">
                  {#each allDay as e (e.id)}
                    <button class="adchip" class:cancelled={e.isCancelled} style:--c={calendar.colorOf(e)} data-event-id={e.id} onclick={() => calendar.openDetails(e.id)}>{e.subject || "(no title)"}</button>
                  {/each}
                </div>
              {/if}
              <div class="list">
                {#each timed as e (e.id)}
                  {#if gaps.has(e.id)}
                    {@const g = gaps.get(e.id)!}
                    <div class="gap"><span class="gline"></span><span class="glbl mono">{hm(g.start)}–{hm(g.end)} · {gapLabel(g.mins)}</span><span class="gline"></span></div>
                  {/if}
                  <EventRow ev={e} highlight={isToday && e.id === nextId} overlap={overlapIds.has(e.id)} {showAccount} dense />
                {/each}
                {#if gaps.has("end") && timed.length}
                  {@const g = gaps.get("end")!}
                  <div class="gap"><span class="gline"></span><span class="glbl mono">{hm(g.start)}–{hm(g.end)} · {gapLabel(g.mins)}</span><span class="gline"></span></div>
                {/if}
              </div>
            </div>
          {/if}
        </section>
      {/if}
    {/each}

    <div class="hint-row">
      <span><kbd>j</kbd><kbd>k</kbd> move</span>
      <span><kbd>↵</kbd> details</span>
      <span><kbd>e</kbd> edit</span>
      <span><kbd>n</kbd> new</span>
      <span><kbd>h</kbd><kbd>l</kbd> period</span>
      <span><kbd>d</kbd><kbd>w</kbd><kbd>m</kbd><kbd>a</kbd> views</span>
    </div>
  </div>
</div>

<style>
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .canvas {
    max-width: 920px;
    margin: 0 auto;
    padding: 18px 40px 80px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .wksep {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .wksep::before,
  .wksep::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .dayblock {
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: fade-up 240ms var(--ease) both;
    animation-delay: calc(var(--i, 0) * 20ms);
  }
  .dayhead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 0 4px;
    align-self: flex-start;
    border-radius: 6px;
  }
  .dayhead:hover .dow {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .dow {
    font-size: 14px;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--fg-bright);
  }
  .dow.accent {
    color: var(--accent);
  }
  .date {
    font-size: 11.5px;
    color: var(--muted);
  }
  .muted {
    font-size: 12.5px;
    color: var(--muted);
  }
  .card {
    padding: 6px;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .dayblock.today .card {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 22%, var(--line));
  }
  .allday {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 4px 6px;
  }
  .adchip {
    max-width: 320px;
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--fg);
    background: color-mix(in oklab, var(--c, var(--blue)) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--c, var(--blue)) 35%, transparent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .adchip.cancelled {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .gap {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 14px 2px 88px;
    height: 20px;
  }
  .gline {
    flex: 1;
    height: 1px;
    background: repeating-linear-gradient(90deg, var(--line-strong) 0 4px, transparent 4px 8px);
  }
  .glbl {
    font-size: 10px;
    color: var(--green);
    white-space: nowrap;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 6px;
    padding: 40px 20px 20px;
    color: var(--fg-dim);
  }
  .empty .mark {
    opacity: 0.6;
    margin-bottom: 6px;
  }
  .empty h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
  }
  .empty p {
    margin: 0 0 8px;
    font-size: 13px;
  }
  .hint-row {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    justify-content: center;
    font-size: 11.5px;
    color: var(--muted);
    padding-top: 8px;
  }
  .hint-row kbd {
    margin-right: 3px;
  }
  @media (max-width: 1000px) {
    .canvas {
      padding: 16px 22px 60px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dayblock {
      animation: none;
    }
  }
</style>
