<script lang="ts">
  // Small month navigator in the calendar rail: Monday-first, ISO week numbers, dots for days with events.
  import { calendar } from "$lib/state/calendar.svelte";
  import { addMonths, dayKey, monthGrid, startOfMonth, isBusy } from "$lib/util/cal";
  import { isoWeek, monthYear, weekdayShort } from "$lib/util/fmt";
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";

  let shown = $state(startOfMonth(new Date()));
  // Follow the main view when it moves to another month.
  $effect(() => {
    const m = startOfMonth(calendar.anchor);
    if (m.getTime() !== shown.getTime()) shown = m;
  });

  const grid = $derived(monthGrid(shown));
  const weeks = $derived(Array.from({ length: 6 }, (_, i) => grid.slice(i * 7, i * 7 + 7)));
  const todayKey = $derived(dayKey(calendar.now));
  const headers = $derived(grid.slice(0, 7).map((d) => weekdayShort(d).slice(0, 2)));
  const busyDays = $derived.by(() => {
    const s = new Set<string>();
    for (const e of calendar.visible) if (isBusy(e) || e.isAllDay) s.add(dayKey(e.start));
    return s;
  });
  const inPeriod = (d: Date) => d >= calendar.period.from && d < calendar.period.to;
</script>

<div class="mini">
  <div class="head">
    <button class="nb" onclick={() => (shown = addMonths(shown, -1))} aria-label="Previous month"><ChevronLeft size={13} /></button>
    <button class="title" onclick={() => calendar.goto(shown, "month")} title="Open month">{monthYear(shown)}</button>
    <button class="nb" onclick={() => (shown = addMonths(shown, 1))} aria-label="Next month"><ChevronRight size={13} /></button>
  </div>
  <div class="grid" class:wk={calendar.showWeekNumbers}>
    {#if calendar.showWeekNumbers}<span class="h"></span>{/if}
    {#each headers as h, i (i)}<span class="h">{h}</span>{/each}
    {#each weeks as week (dayKey(week[0]))}
      {#if calendar.showWeekNumbers}
        <button class="wn mono" onclick={() => calendar.goto(week[0], "week")} title="Week {isoWeek(week[0])}">{isoWeek(week[0])}</button>
      {/if}
      {#each week as d (dayKey(d))}
        {@const k = dayKey(d)}
        <button
          class="d"
          class:out={d.getMonth() !== shown.getMonth()}
          class:today={k === todayKey}
          class:sel={inPeriod(d)}
          class:wkend={d.getDay() === 0 || d.getDay() === 6}
          onclick={() => calendar.goto(d, calendar.view === "month" ? "day" : undefined)}>
          {d.getDate()}
          {#if busyDays.has(k)}<span class="dot"></span>{/if}
        </button>
      {/each}
    {/each}
  </div>
</div>

<style>
  .mini {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 2px 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    font-size: 12.5px;
    font-weight: 650;
    color: var(--fg-bright);
    padding: 2px 6px;
    border-radius: 6px;
  }
  .title:hover {
    background: var(--hover);
  }
  .nb {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    color: var(--muted);
  }
  .nb:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px 0;
  }
  .grid.wk {
    grid-template-columns: 22px repeat(7, 1fr);
  }
  .h {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    text-align: center;
    padding: 2px 0 4px;
  }
  .wn {
    font-size: 9px;
    color: var(--muted);
    opacity: 0.8;
    border-radius: 5px;
  }
  .wn:hover {
    background: var(--hover);
    opacity: 1;
  }
  .d {
    position: relative;
    height: 26px;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
    border-radius: 7px;
    transition: background var(--t);
  }
  .d:hover {
    background: var(--hover);
  }
  .d.out {
    color: var(--muted);
    opacity: 0.55;
  }
  .d.wkend:not(.out) {
    color: var(--fg-dim);
  }
  .d.sel {
    background: var(--accent-soft);
  }
  .d.today {
    color: var(--on-accent);
    background: var(--accent);
    font-weight: 700;
  }
  .dot {
    position: absolute;
    left: 50%;
    bottom: 2px;
    width: 3px;
    height: 3px;
    margin-left: -1.5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
  }
</style>
