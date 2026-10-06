<script lang="ts">
  // Month view: Monday-first 6×7 grid with ISO week numbers, up to N chips per day, "+n more" opens the day.
  import { calendar } from "$lib/state/calendar.svelte";
  import type { CalEvent } from "$lib/types";
  import { dayKey, hm, isBusy, toLocalIso } from "$lib/util/cal";
  import { isoWeek, weekdayShort, monthLong } from "$lib/util/fmt";
  import { Lock, Repeat, Video } from "@lucide/svelte";

  const grid = $derived(calendar.days);
  const weeks = $derived(Array.from({ length: 6 }, (_, i) => grid.slice(i * 7, i * 7 + 7)));
  const month = $derived(calendar.anchor.getMonth());
  const todayKey = $derived(dayKey(calendar.now));
  const headers = $derived(grid.slice(0, 7).map((d) => weekdayShort(d)));
  const showWeekends = $derived(calendar.showWeekends);
  const nowIso = $derived(toLocalIso(calendar.now));

  let cellEl: HTMLDivElement | undefined = $state();
  let perCell = $state(3);
  // Fit as many chips as the row height allows.
  $effect(() => {
    if (!cellEl) return;
    const ro = new ResizeObserver(() => {
      const h = cellEl!.clientHeight - 26;
      perCell = Math.max(1, Math.floor(h / 20));
    });
    ro.observe(cellEl);
    return () => ro.disconnect();
  });

  const byDay = $derived.by(() => {
    const m = new Map<string, CalEvent[]>();
    for (const d of grid) m.set(dayKey(d), calendar.eventsOn(d));
    return m;
  });

  function chipStyle(e: CalEvent) {
    return `--c: ${calendar.colorOf(e)}`;
  }
  function onCellDblClick(d: Date) {
    calendar.composeAt(d, null);
  }
  function onDrop(e: DragEvent, d: Date) {
    e.preventDefault();
    const id = e.dataTransfer?.getData("text/tern-event");
    const ev = id ? calendar.events.find((x) => x.id === id) : null;
    if (!ev) return;
    const s = new Date(ev.start);
    const en = new Date(ev.end);
    const ns = new Date(d.getFullYear(), d.getMonth(), d.getDate(), s.getHours(), s.getMinutes());
    const ne = new Date(ns.getTime() + (en.getTime() - s.getTime()));
    calendar.move(ev, toLocalIso(ns), toLocalIso(ne)).catch(() => {});
  }
  function onDragStart(e: DragEvent, ev: CalEvent) {
    const editable = calendar.canChangeTime(ev);
    if (!editable) {
      e.preventDefault();
      return;
    }
    e.dataTransfer?.setData("text/tern-event", ev.id);
    e.dataTransfer!.effectAllowed = "move";
  }
</script>

<div class="mg" class:wk={calendar.showWeekNumbers} class:noweekend={!showWeekends}>
  <div class="head">
    {#if calendar.showWeekNumbers}<span class="h"></span>{/if}
    {#each headers as h, i (i)}
      {#if showWeekends || i < 5}<span class="h" class:we={i >= 5}>{h}</span>{/if}
    {/each}
  </div>
  <div class="rows">
    {#each weeks as week (dayKey(week[0]))}
      <div class="row">
        {#if calendar.showWeekNumbers}
          <button class="wn mono" onclick={() => calendar.goto(week[0], "week")} title="Open week {isoWeek(week[0])}">{isoWeek(week[0])}</button>
        {/if}
        {#each week as d, di (dayKey(d))}
          {#if showWeekends || di < 5}
            {@const k = dayKey(d)}
            {@const evs = byDay.get(k) ?? []}
            {@const more = evs.length - perCell}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="cell"
              class:out={d.getMonth() !== month}
              class:today={k === todayKey}
              class:we={di >= 5}
              bind:this={cellEl}
              ondblclick={() => onCellDblClick(d)}
              ondragover={(e) => e.preventDefault()}
              ondrop={(e) => onDrop(e, d)}>
              <button class="dn" onclick={() => calendar.goto(d, "day")}>
                {#if d.getDate() === 1}<span class="mn">{monthLong(d).slice(0, 3)}</span>{/if}
                {d.getDate()}
              </button>
              <div class="chips">
                {#each evs.slice(0, more > 1 ? perCell - 1 : perCell) as e (e.id)}
                  <button
                    class="chip"
                    class:allday={e.isAllDay}
                    class:past={e.end <= nowIso}
                    class:cancelled={e.isCancelled || e.response === "declined"}
                    class:free={!isBusy(e) && !e.isCancelled && e.response !== "declined"}
                    class:ask={e.response === "notResponded" && !e.isCancelled}
                    class:sel={calendar.selectedId === e.id}
                    style={chipStyle(e)}
                    data-event-id={e.id}
                    draggable="true"
                    ondragstart={(de) => onDragStart(de, e)}
                    onclick={(ce) => {
                      ce.stopPropagation();
                      calendar.openDetails(e.id);
                    }}
                    title="{e.isAllDay ? '' : hm(e.start) + ' '}{e.subject}">
                    {#if !e.isAllDay}<span class="t mono">{hm(e.start)}</span>{/if}
                    <span class="s">{e.subject || "(no title)"}</span>
                    {#if e.isOnline}<Video size={9} />{/if}
                    {#if e.seriesMasterId}<Repeat size={9} />{/if}
                    {#if e.sensitivity === "private"}<Lock size={9} />{/if}
                  </button>
                {/each}
                {#if more > 1}
                  <button class="more" onclick={() => calendar.goto(d, "day")}>+{more} more</button>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .mg {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    --cols: 7;
  }
  .noweekend {
    --cols: 5;
  }
  .head,
  .row {
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  }
  .wk .head,
  .wk .row {
    grid-template-columns: 30px repeat(var(--cols), minmax(0, 1fr));
  }
  .head {
    border-bottom: 1px solid var(--line);
  }
  .h {
    padding: 8px 10px 6px;
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .h.we {
    opacity: 0.7;
  }
  .rows {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: repeat(6, minmax(0, 1fr));
  }
  .row {
    border-bottom: 1px solid var(--line);
    min-height: 0;
  }
  .wn {
    font-size: 10px;
    color: var(--muted);
    padding-top: 8px;
    align-self: start;
    border-right: 1px solid var(--line);
    height: 100%;
  }
  .wn:hover {
    color: var(--accent);
    background: var(--hover);
  }
  .cell {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 4px 2px;
    border-right: 1px solid var(--line);
    min-height: 0;
    overflow: hidden;
    transition: background var(--t);
  }
  .cell:last-child {
    border-right: 0;
  }
  .cell.we {
    background: color-mix(in oklab, var(--fg) 1.5%, transparent);
  }
  .cell.out {
    background: color-mix(in oklab, var(--bg-darker) 35%, transparent);
  }
  .cell.out .dn {
    color: var(--muted);
    opacity: 0.6;
  }
  .cell.today {
    background: color-mix(in oklab, var(--accent) 5%, transparent);
  }
  .dn {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    min-width: 20px;
    padding: 0 5px;
    margin: 0 0 0 2px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
  }
  .dn:hover {
    background: var(--hover);
  }
  .today .dn {
    background: var(--accent);
    color: var(--on-accent);
  }
  .mn {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .today .mn {
    color: var(--on-accent);
  }
  .chips {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 18px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--fg);
    text-align: left;
    min-width: 0;
    transition: background var(--t);
  }
  .chip:hover {
    background: var(--hover);
  }
  .chip::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--c);
    flex: none;
  }
  .chip.allday {
    color: var(--fg-bright);
    background: color-mix(in oklab, var(--c) 28%, var(--bg));
  }
  .chip.allday::before {
    display: none;
  }
  .chip.past {
    opacity: 0.55;
  }
  .chip.cancelled .s {
    text-decoration: line-through;
    color: var(--muted);
  }
  .chip.free::before {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--c);
  }
  .chip.ask {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--red) 50%, transparent);
  }
  .chip.sel {
    box-shadow: 0 0 0 2px var(--accent-line);
  }
  .t {
    font-size: 10px;
    color: var(--fg-dim);
    flex: none;
  }
  .s {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    align-self: flex-start;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--accent);
    padding: 0 5px;
    height: 16px;
    border-radius: 4px;
  }
  .more:hover {
    background: var(--accent-soft);
  }
</style>
