<script lang="ts">
  // Day / week time grid: hour axis (24h), all-day row, events laid out side by side where they overlap,
  // now line, working-hours shading. Click or drag on empty space creates an event; drag an event to move it,
  // drag its bottom edge to resize.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import type { CalEvent } from "$lib/types";
  import { addDays, dayKey, layoutDay, minutesBetween, minutesIntoDay, snap, toLocalIso, isBusy, hm, durationLabel, type Placed } from "$lib/util/cal";
  import { weekdayShort } from "$lib/util/fmt";
  import { Video, MapPin, Repeat, Lock, CircleAlert } from "@lucide/svelte";
  import { tick } from "svelte";

  const HOUR = 52; // px per hour
  const STEP = 15; // snap minutes
  const days = $derived(calendar.days);
  const todayKey = $derived(dayKey(calendar.now));
  const ws = $derived(mins(app.settings?.calendar.workStart ?? "09:00"));
  const we = $derived(mins(app.settings?.calendar.workEnd ?? "17:00"));
  const hours = Array.from({ length: 24 }, (_, i) => i);

  function mins(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  const pad = (n: number) => String(n).padStart(2, "0");

  interface Col {
    day: Date;
    key: string;
    allDay: CalEvent[];
    placed: Placed<CalEvent>[];
    overlapIds: Set<string>;
  }
  const cols = $derived.by<Col[]>(() =>
    days.map((day) => {
      const evs = calendar.eventsOn(day);
      const dayEnd = toLocalIso(addDays(day, 1));
      // Timed events that span past midnight are drawn as all-day-ish bars on the days they cover.
      const timed = evs.filter((e) => !e.isAllDay && !(e.start < toLocalIso(day) && e.end >= dayEnd));
      const allDay = evs.filter((e) => e.isAllDay || (e.start < toLocalIso(day) && e.end >= dayEnd));
      return { day, key: dayKey(day), allDay, placed: layoutDay(timed, day), overlapIds: calendar.overlapIds(evs) };
    }),
  );
  const maxAllDay = $derived(Math.max(0, ...cols.map((c) => c.allDay.length)));
  const nowMins = $derived(calendar.now.getHours() * 60 + calendar.now.getMinutes());

  // ---- scroll to working hours on first paint / view change ----
  let scroller: HTMLDivElement | undefined = $state();
  let scrolledFor = "";
  $effect(() => {
    const key = `${calendar.view}:${dayKey(calendar.period.from)}`;
    void cols;
    if (!scroller || scrolledFor === key) return;
    scrolledFor = key;
    tick().then(() => {
      if (!scroller) return;
      const target = calendar.isTodayVisible ? Math.max(0, nowMins - 90) : Math.max(0, ws - 30);
      scroller.scrollTop = (target / 60) * HOUR;
    });
  });

  // ---- pointer interactions ----
  type Drag =
    | { kind: "create"; col: number; from: number; to: number; moved: boolean }
    | { kind: "move"; ev: CalEvent; col: number; startCol: number; grab: number; dur: number; top: number; moved: boolean }
    | { kind: "resize"; ev: CalEvent; col: number; top: number; bottom: number; moved: boolean };
  let drag = $state<Drag | null>(null);
  let gridEl: HTMLDivElement | undefined = $state();

  function yToMins(clientY: number): number {
    if (!gridEl) return 0;
    const r = gridEl.getBoundingClientRect();
    return Math.max(0, Math.min(1440, ((clientY - r.top) / HOUR) * 60));
  }
  function xToCol(clientX: number): number {
    if (!gridEl) return 0;
    const r = gridEl.getBoundingClientRect();
    return Math.max(0, Math.min(cols.length - 1, Math.floor(((clientX - r.left) / r.width) * cols.length)));
  }

  function onColDown(e: PointerEvent, col: number) {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".ev")) return;
    const m = snap(Math.floor(yToMins(e.clientY) / STEP) * STEP, STEP);
    drag = { kind: "create", col, from: m, to: m + 30, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onEvDown(e: PointerEvent, ev: CalEvent, col: number, p: Placed<CalEvent>) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const y = yToMins(e.clientY);
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const nearBottom = e.clientY > r.bottom - 8;
    if (nearBottom && canEdit(ev)) drag = { kind: "resize", ev, col, top: p.top, bottom: p.bottom, moved: false };
    else {
      // Real start and length (the drawn box is padded to a minimum height and clipped to the day).
      const realTop = minutesIntoDay(ev.start, cols[col].day);
      drag = { kind: "move", ev, col, startCol: col, grab: y - realTop, dur: minutesBetween(ev.start, ev.end), top: realTop, moved: false };
    }
    el.setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!drag) return;
    const y = yToMins(e.clientY);
    if (drag.kind === "create") {
      const m = snap(y, STEP);
      drag = { ...drag, to: Math.max(drag.from + STEP, m), moved: true };
    } else if (drag.kind === "move") {
      if (!canEdit(drag.ev)) return;
      const top = Math.max(0, Math.min(1440 - Math.min(drag.dur, 1440), snap(y - drag.grab, STEP)));
      drag = { ...drag, top, col: xToCol(e.clientX), moved: drag.moved || Math.abs(top - minutesIntoDay(drag.ev.start, cols[drag.startCol].day)) >= STEP || xToCol(e.clientX) !== drag.startCol };
    } else {
      drag = { ...drag, bottom: Math.max(drag.top + STEP, Math.min(1440, snap(y, STEP))), moved: true };
    }
  }
  async function onUp() {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "create") {
      const day = cols[d.col].day;
      calendar.composeAt(day, d.from, d.moved ? d.to - d.from : undefined);
      return;
    }
    if (!d.moved) {
      calendar.openDetails(d.ev.id);
      return;
    }
    const day = cols[d.col].day;
    const at = (m: number) => toLocalIso(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m));
    if (d.kind === "move") await calendar.move(d.ev, at(d.top), at(d.top + d.dur)).catch(() => {});
    else await calendar.move(d.ev, d.ev.start, at(d.bottom)).catch(() => {});
  }
  function canEdit(ev: CalEvent): boolean {
    return !ev.isCancelled && (calendar.calendarById.get(ev.calendarId)?.canEdit ?? true);
  }

  /** Where an event is drawn, taking an in-progress drag into account (clipped to the day like layoutDay). */
  function box(p: Placed<CalEvent>, colIdx: number): { top: number; height: number; hidden: boolean } {
    if (drag && drag.kind !== "create" && drag.ev.id === p.item.id) {
      if (drag.kind === "move") {
        const top = Math.max(0, drag.top);
        const bottom = Math.min(1440, Math.max(top + 20, drag.top + drag.dur));
        return { top, height: bottom - top, hidden: drag.col !== colIdx };
      }
      return { top: drag.top, height: drag.bottom - drag.top, hidden: false };
    }
    return { top: p.top, height: p.bottom - p.top, hidden: false };
  }
  const ghost = $derived.by(() => {
    if (!drag) return null;
    if (drag.kind === "create") return { col: drag.col, top: drag.from, height: drag.to - drag.from, label: `${lbl(drag.from)}–${lbl(drag.to)}` };
    if (drag.kind === "move" && drag.col !== drag.startCol) return { col: drag.col, top: drag.top, height: drag.dur, label: `${lbl(drag.top)}–${lbl(drag.top + drag.dur)}` };
    return null;
  });
  const lbl = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  const cursor = $derived(calendar.cursor);
  // Keep the keyboard cursor in view.
  $effect(() => {
    if (!cursor || !scroller) return;
    const top = (cursor.mins / 60) * HOUR;
    const bottom = ((cursor.mins + cursor.len) / 60) * HOUR;
    if (top < scroller.scrollTop + 20) scroller.scrollTop = Math.max(0, top - 60);
    else if (bottom > scroller.scrollTop + scroller.clientHeight - 20) scroller.scrollTop = bottom - scroller.clientHeight + 60;
  });

  function style(ev: CalEvent): string {
    return `--c: ${calendar.colorOf(ev)}`;
  }
  const past = (ev: CalEvent) => ev.end <= toLocalIso(calendar.now);
</script>

<div class="tg" class:single={cols.length === 1}>
  <div class="head" style:--n={cols.length}>
    <div class="gutter"></div>
    {#each cols as c (c.key)}
      <button class="dh" class:today={c.key === todayKey} class:wkend={c.day.getDay() === 0 || c.day.getDay() === 6} onclick={() => calendar.goto(c.day, "day")}>
        <span class="dow">{weekdayShort(c.day)}</span>
        <span class="num">{c.day.getDate()}</span>
      </button>
    {/each}
  </div>

  {#if maxAllDay}
    <div class="allday" style:--n={cols.length}>
      <div class="gutter lbl mono">all day</div>
      {#each cols as c, ci (c.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="adcell" class:today={c.key === todayKey} ondblclick={() => calendar.composeAt(c.day, null)}>
          {#each c.allDay as e (e.id)}
            <button
              class="adchip"
              class:cancelled={e.isCancelled}
              class:declined={e.response === "declined"}
              class:sel={calendar.selectedId === e.id}
              style={style(e)}
              data-event-id={e.id}
              onclick={() => calendar.openDetails(e.id)}
              title={e.subject}>
              {#if e.sensitivity === "private"}<Lock size={9} />{/if}
              {e.subject || "(no title)"}
            </button>
          {/each}
        </div>
      {/each}
    </div>
  {/if}

  <div class="scroll" bind:this={scroller}>
    <div class="canvas" style:height="{24 * HOUR}px" style:--n={cols.length}>
      <div class="axis">
        {#each hours as h (h)}
          <div class="hr" style:top="{h * HOUR}px"><span class="mono">{#if h}{pad(h)}:00{/if}</span></div>
        {/each}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="grid" bind:this={gridEl} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp}>
        {#each hours as h (h)}
          <div class="line" style:top="{h * HOUR}px"></div>
          <div class="line half" style:top="{h * HOUR + HOUR / 2}px"></div>
        {/each}
        {#each cols as c, ci (c.key)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="col" class:today={c.key === todayKey} class:wkend={c.day.getDay() === 0 || c.day.getDay() === 6} onpointerdown={(e) => onColDown(e, ci)}>
            <div class="work" style:top="{(ws / 60) * HOUR}px" style:height="{((we - ws) / 60) * HOUR}px"></div>
            {#each c.placed as p (p.item.id)}
              {@const e = p.item}
              {@const b = box(p, ci)}
              {@const w = 100 / p.cols}
                <!-- Stays mounted while hidden: it holds the pointer capture during a cross-day drag. -->
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <div
                  class="ev"
                  class:hidden={b.hidden}
                  class:past={past(e)}
                  class:cancelled={e.isCancelled}
                  class:declined={e.response === "declined"}
                  class:tentative={e.response === "tentativelyAccepted" || e.showAs === "tentative"}
                  class:free={e.showAs === "free"}
                  class:ask={e.response === "notResponded"}
                  class:sel={calendar.selectedId === e.id}
                  class:dragging={drag && drag.kind !== "create" && drag.ev.id === e.id}
                  class:short={b.height < 40}
                  class:tiny={b.height < 24}
                  class:editable={canEdit(e)}
                  style="{style(e)}; top: {(b.top / 60) * HOUR}px; height: {(b.height / 60) * HOUR - 2}px; left: calc({p.col * w}% + 2px); width: calc({w}% - 4px);"
                  data-event-id={e.id}
                  onpointerdown={(pe) => onEvDown(pe, e, ci, p)}
                  role="button"
                  tabindex="-1">
                  <div class="t">
                    <span class="title">{e.subject || "(no title)"}</span>
                    {#if e.response === "notResponded" && !e.isCancelled}<CircleAlert size={11} class="warn" />{/if}
                  </div>
                  <div class="m mono">
                    {hm(e.start)}–{hm(e.end)}
                    {#if c.overlapIds.has(e.id) && isBusy(e)}<span class="ovl">overlaps</span>{/if}
                  </div>
                  {#if b.height >= 56}
                    <div class="x">
                      {#if e.isOnline}<Video size={10} />{:else if e.location}<MapPin size={10} /><span class="loc">{e.location}</span>{/if}
                      {#if e.seriesMasterId}<Repeat size={10} />{/if}
                      {#if e.sensitivity === "private"}<Lock size={10} />{/if}
                    </div>
                  {/if}
                  {#if canEdit(e)}<div class="rs"></div>{/if}
                </div>
            {/each}
            {#if ghost && ghost.col === ci}
              <div class="ghost" style:top="{(ghost.top / 60) * HOUR}px" style:height="{(ghost.height / 60) * HOUR - 2}px">
                <span class="mono">{ghost.label}</span>
              </div>
            {/if}
            {#if cursor && cursor.col === ci}
              <button class="cursor" style:top="{(cursor.mins / 60) * HOUR}px" style:height="{(cursor.len / 60) * HOUR - 2}px" onclick={() => calendar.composeAtCursor()} title="Enter: new event here">
                <span class="mono">{lbl(cursor.mins)}–{lbl(cursor.mins + cursor.len)}</span>
                <span class="hintk"><kbd>↵</kbd> new</span>
              </button>
            {/if}
            {#if c.key === todayKey}
              <div class="now" style:top="{(nowMins / 60) * HOUR}px"><span class="dot"></span></div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
  {#if drag}
    <div class="hint mono">
      {#if drag.kind === "create"}New event {lbl(drag.from)}–{lbl(drag.to)} · {durationLabel("2000-01-01T00:00:00", `2000-01-01T${lbl(drag.to - drag.from)}:00`)}{:else if drag.kind === "move"}{lbl(drag.top)}–{lbl(drag.top + drag.dur)}{:else}{lbl(drag.top)}–{lbl(drag.bottom)}{/if}
    </div>
  {/if}
</div>

<style>
  .tg {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    --gutter: 52px;
  }
  .head,
  .allday {
    display: grid;
    grid-template-columns: var(--gutter) repeat(var(--n), minmax(0, 1fr));
    border-bottom: 1px solid var(--line);
  }
  .head {
    padding-right: 8px; /* scrollbar */
  }
  .dh {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 6px;
    padding: 10px 4px 8px;
    border-left: 1px solid var(--line);
    transition: background var(--t);
  }
  .dh:hover {
    background: var(--hover);
  }
  .dow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .dh.wkend .dow {
    opacity: 0.7;
  }
  .num {
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
    min-width: 26px;
    text-align: center;
    border-radius: 8px;
    padding: 0 4px;
  }
  .dh.today .num {
    background: var(--accent);
    color: var(--on-accent);
  }
  .dh.today .dow {
    color: var(--accent);
  }
  .allday {
    padding-right: 8px;
    max-height: 96px;
    overflow-y: auto;
  }
  .allday .lbl {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    text-align: right;
    padding: 6px 8px 0 0;
  }
  .adcell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 3px 3px;
    border-left: 1px solid var(--line);
    min-height: 26px;
  }
  .adcell.today {
    background: color-mix(in oklab, var(--accent) 4%, transparent);
  }
  .adchip {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 7px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 550;
    color: var(--fg-bright);
    background: color-mix(in oklab, var(--c) 28%, var(--bg));
    border-left: 3px solid var(--c);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  .adchip.cancelled,
  .adchip.declined {
    text-decoration: line-through;
    opacity: 0.55;
  }
  .adchip.sel {
    box-shadow: 0 0 0 2px var(--accent-line);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: scroll;
    overflow-x: hidden;
  }
  .canvas {
    position: relative;
    display: grid;
    grid-template-columns: var(--gutter) minmax(0, 1fr);
  }
  .axis {
    position: relative;
  }
  .hr {
    position: absolute;
    right: 8px;
    transform: translateY(-50%);
    font-size: 10px;
    color: var(--muted);
  }
  .grid {
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
    touch-action: none;
  }
  .line {
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    background: var(--line);
    pointer-events: none;
  }
  .line.half {
    background: color-mix(in oklab, var(--fg) 4%, transparent);
  }
  .col {
    position: relative;
    border-left: 1px solid var(--line);
    cursor: cell;
  }
  .col.today {
    background: color-mix(in oklab, var(--accent) 3.5%, transparent);
  }
  .col.wkend {
    background: color-mix(in oklab, var(--fg) 1.5%, transparent);
  }
  .work {
    position: absolute;
    left: 0;
    right: 0;
    background: color-mix(in oklab, var(--fg-bright) 2.5%, transparent);
    pointer-events: none;
  }
  .ev {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px 6px 3px 7px;
    border-radius: 7px;
    overflow: hidden;
    background: color-mix(in oklab, var(--c) 26%, var(--bg));
    border-left: 3px solid var(--c);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--c) 20%, transparent), 0 1px 0 rgb(0 0 0 / 0.08);
    cursor: default;
    user-select: none;
    transition: box-shadow var(--t), filter var(--t);
    z-index: 1;
  }
  .ev.editable {
    cursor: grab;
  }
  .ev:hover {
    filter: brightness(1.08);
    z-index: 2;
  }
  .ev.sel {
    box-shadow: 0 0 0 2px var(--accent-line);
    z-index: 3;
  }
  .ev.hidden {
    visibility: hidden;
  }
  .ev.dragging {
    opacity: 0.85;
    box-shadow: var(--shadow);
    z-index: 5;
    cursor: grabbing;
  }
  .ev.past {
    opacity: 0.55;
  }
  .ev.tentative {
    background: repeating-linear-gradient(135deg, color-mix(in oklab, var(--c) 22%, var(--bg)) 0 6px, color-mix(in oklab, var(--c) 10%, var(--bg)) 6px 12px);
  }
  .ev.free {
    background: transparent;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--c) 45%, transparent);
  }
  .ev.ask {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--red) 55%, transparent);
  }
  .ev.cancelled .title,
  .ev.declined .title {
    text-decoration: line-through;
    color: var(--muted);
  }
  .t {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .t :global(.warn) {
    color: var(--red);
    flex: none;
  }
  .title {
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-bright);
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m {
    font-size: 10px;
    color: var(--fg-dim);
    display: flex;
    gap: 6px;
    white-space: nowrap;
  }
  .ovl {
    color: var(--red);
  }
  .x {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: var(--muted);
    min-width: 0;
    margin-top: 1px;
  }
  .loc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .short {
    padding-top: 2px;
    flex-direction: row;
    align-items: baseline;
    gap: 6px;
  }
  .short .m {
    flex: none;
  }
  .tiny .m {
    display: none;
  }
  .tiny .title {
    font-size: 11px;
  }
  .rs {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 7px;
    cursor: ns-resize;
  }
  .ghost {
    position: absolute;
    left: 2px;
    right: 2px;
    border-radius: 7px;
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
    display: flex;
    align-items: flex-start;
    padding: 4px 7px;
    font-size: 10.5px;
    color: var(--accent);
    pointer-events: none;
    z-index: 4;
  }
  .cursor {
    position: absolute;
    left: 2px;
    right: 2px;
    border-radius: 7px;
    background: color-mix(in oklab, var(--accent) 14%, transparent);
    box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 4px color-mix(in oklab, var(--accent) 12%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
    padding: 4px 7px;
    font-size: 10.5px;
    color: var(--accent);
    z-index: 4;
    animation: fade-up 120ms var(--ease);
  }
  .hintk {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--fg-dim);
  }
  .now {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--red);
    pointer-events: none;
    z-index: 6;
  }
  .now .dot {
    position: absolute;
    left: -5px;
    top: -4px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--red);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--red) 25%, transparent);
  }
  .hint {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 11px;
    color: var(--fg-bright);
    background: var(--raised);
    box-shadow: var(--shadow-sm);
    pointer-events: none;
    z-index: 10;
  }
  .single .dh {
    justify-content: flex-start;
    padding-left: 14px;
  }
</style>
