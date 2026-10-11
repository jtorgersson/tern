<script lang="ts">
  // Day / week time grid: hour axis (working hours by default), all-day row, events laid out side by side
  // where they overlap, now line, open-time bands, working-hours shading. Click or drag on empty space
  // creates an event; drag an event to move it, drag its bottom edge to resize.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import type { CalEvent } from "$lib/types";
  import { addDays, busyMinutes, clockNote, dayKey, durationLabel, freeGaps, hm, isBusy, layoutDay, minutesBetween, minutesIntoDay, snap, toLocalIso, type Placed } from "$lib/util/cal";
  import { fmtMins } from "$lib/util/insights";
  import { weekdayShort, hhmmIn, tzLabel } from "$lib/util/fmt";
  import { Video, MapPin, Repeat, Lock, CircleAlert, NotebookPen, Shield } from "@lucide/svelte";
  import { tick } from "svelte";

  const HOUR = 52; // px per hour
  const STEP = 15; // snap minutes
  const ALLDAY_CAP = 2;
  const days = $derived(calendar.days);
  const todayKey = $derived(dayKey(calendar.now));
  const workStart = $derived(app.settings?.calendar.workStart ?? "09:00");
  const workEnd = $derived(app.settings?.calendar.workEnd ?? "17:00");
  const ws = $derived(mins(workStart));
  const we = $derived(mins(workEnd));
  /** Empty hours outside work are hidden until the user asks for the full day. */
  let fitHours = $state(true);
  try {
    fitHours = localStorage.getItem("tern.calHours") !== "all";
  } catch {}
  function toggleFit() {
    const anchor = scroller ? win.lo + (scroller.scrollTop / HOUR) * 60 : ws;
    fitHours = !fitHours;
    try {
      localStorage.setItem("tern.calHours", fitHours ? "fit" : "all");
    } catch {}
    tick().then(() => {
      if (!scroller) return;
      scroller.scrollTop = Math.max(0, yPx(anchor));
      measureNow();
    });
  }

  function mins(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  const pad = (n: number) => String(n).padStart(2, "0");

  interface OpenBand {
    top: number;
    height: number;
    start: string;
    end: string;
  }
  interface Col {
    day: Date;
    key: string;
    allDay: CalEvent[];
    placed: Placed<CalEvent>[];
    overlapIds: Set<string>;
    /** 0–1 of working hours taken by busy meetings. */
    load: number;
    loadLabel: string;
    opens: OpenBand[];
  }
  const cols = $derived.by<Col[]>(() =>
    days.map((day) => {
      const evs = calendar.eventsOn(day);
      const dayEnd = toLocalIso(addDays(day, 1));
      // Timed events that span past midnight are drawn as all-day-ish bars on the days they cover.
      const timed = evs.filter((e) => !e.isAllDay && !(e.start < toLocalIso(day) && e.end >= dayEnd));
      const allDay = evs.filter((e) => e.isAllDay || (e.start < toLocalIso(day) && e.end >= dayEnd));
      const taken = busyMinutes(evs, day, ws, we);
      const span = Math.max(1, we - ws);
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      const key = dayKey(day);
      const hasBusy = timed.some((e) => isBusy(e));
      const opens: OpenBand[] = weekend || !hasBusy
        ? []
        : freeGaps(evs, day, workStart, workEnd, 60)
            .filter((g) => key !== todayKey || g.end > toLocalIso(calendar.now))
            .map((g) => {
              let start = g.start;
              if (key === todayKey && start < toLocalIso(calendar.now)) {
                const snapped = new Date(calendar.now);
                snapped.setSeconds(0, 0);
                const rem = snapped.getMinutes() % 15;
                if (rem) snapped.setMinutes(snapped.getMinutes() + (15 - rem));
                start = toLocalIso(snapped);
              }
              const top = Math.max(0, minutesIntoDay(start, day));
              const bottom = Math.min(1440, minutesIntoDay(g.end, day));
              return { top, height: bottom - top, start, end: g.end };
            })
            .filter((g) => g.height >= 45);
      return {
        day,
        key,
        allDay,
        placed: layoutDay(timed, day),
        overlapIds: calendar.overlapIds(evs),
        load: taken > 0 ? Math.min(1, taken / span) : 0,
        loadLabel: taken > 0 ? `${fmtMins(taken)} in meetings` : "",
        opens,
      };
    }),
  );
  let openAllDay = $state<Record<string, boolean>>({});
  const maxAllDay = $derived(Math.max(0, ...cols.map((c) => (openAllDay[c.key] ? c.allDay.length : Math.min(c.allDay.length, ALLDAY_CAP)))));
  const nowMins = $derived(calendar.now.getHours() * 60 + calendar.now.getMinutes());
  /** Visible minute range. Fit mode keeps events outside working hours, and drops the empty edges. */
  const win = $derived.by(() => {
    if (!fitHours) return { lo: 0, hi: 1440 };
    let lo = Math.max(0, ws - 60);
    let hi = Math.min(1440, we + 60);
    for (const c of cols) {
      for (const p of c.placed) {
        lo = Math.min(lo, Math.max(0, p.top));
        hi = Math.max(hi, Math.min(1440, p.bottom));
      }
    }
    lo = Math.floor(lo / 60) * 60;
    hi = Math.ceil(hi / 60) * 60;
    if (hi <= lo) hi = Math.min(1440, lo + 60);
    return { lo, hi };
  });
  const hours = $derived(Array.from({ length: Math.round((win.hi - win.lo) / 60) }, (_, i) => win.lo / 60 + i));

  // ---- scroll to working hours on first paint / view change ----
  let scroller: HTMLDivElement | undefined = $state();
  let scrolledFor = "";
  /** Keep the opening scroll correct while events arrive and the fitted window shifts. */
  let stick = true;
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const release = () => (stick = false);
    el.addEventListener("pointerdown", release);
    el.addEventListener("wheel", release, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", release);
      el.removeEventListener("wheel", release);
    };
  });
  $effect(() => {
    const key = `${calendar.view}:${dayKey(calendar.period.from)}`;
    const lo = win.lo;
    if (scrolledFor !== key) {
      scrolledFor = key;
      stick = true;
    }
    if (!stick) return;
    tick().then(() => {
      if (!scroller || !stick) return;
      const target = calendar.isTodayVisible ? Math.max(lo, nowMins - 90) : Math.max(lo, ws - 30);
      scroller.scrollTop = ((target - lo) / 60) * HOUR;
      measureNow();
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
    if (!gridEl) return win.lo;
    const r = gridEl.getBoundingClientRect();
    return Math.max(win.lo, Math.min(win.hi, win.lo + ((clientY - r.top) / HOUR) * 60));
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
  /** Only the organizer (or an event without attendees) can be dragged; Microsoft rejects time changes from attendees. */
  function canEdit(ev: CalEvent): boolean {
    return calendar.canChangeTime(ev);
  }
  // ---- second time zone in the gutter ----
  const tz2 = $derived(app.settings?.calendar.secondaryTimeZone ?? null);
  const tz2Labels = $derived.by(() => {
    if (!tz2) return [] as string[];
    const base = days[0] ?? new Date();
    return hours.map((h) => hhmmIn(new Date(base.getFullYear(), base.getMonth(), base.getDate(), h), tz2));
  });

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
  // Keep the keyboard cursor in view. Arrowing into a hidden hour opens the full day.
  $effect(() => {
    if (!cursor || !scroller) return;
    if (cursor.mins < win.lo || cursor.mins + cursor.len > win.hi) {
      fitHours = false;
      return;
    }
    const top = ((cursor.mins - win.lo) / 60) * HOUR;
    const bottom = ((cursor.mins + cursor.len - win.lo) / 60) * HOUR;
    if (top < scroller.scrollTop + 20) scroller.scrollTop = Math.max(0, top - 60);
    else if (bottom > scroller.scrollTop + scroller.clientHeight - 20) scroller.scrollTop = bottom - scroller.clientHeight + 60;
  });

  function clashNames(col: number, top: number, bottom: number, ignoreId?: string): string[] {
    const c = cols[col];
    if (!c || bottom <= top) return [];
    const at = (m: number) => toLocalIso(new Date(c.day.getFullYear(), c.day.getMonth(), c.day.getDate(), 0, Math.round(m)));
    const start = at(top);
    const end = at(bottom);
    return c.placed
      .map((p) => p.item)
      .filter((e) => e.id !== ignoreId && isBusy(e) && e.start < end && e.end > start)
      .map((e) => e.subject || "(no title)");
  }
  const dragClash = $derived.by(() => {
    if (!drag) return [] as string[];
    if (drag.kind === "create") return clashNames(drag.col, drag.from, drag.to);
    if (drag.kind === "move") return clashNames(drag.col, drag.top, Math.min(1440, drag.top + drag.dur), drag.ev.id);
    return clashNames(drag.col, drag.top, drag.bottom, drag.ev.id);
  });

  let nowHidden = $state(false);
  function measureNow() {
    if (!scroller || !cols.some((c) => c.key === todayKey)) {
      nowHidden = false;
      return;
    }
    if (nowMins < win.lo || nowMins > win.hi) {
      nowHidden = true;
      return;
    }
    const y = ((nowMins - win.lo) / 60) * HOUR;
    nowHidden = y < scroller.scrollTop + 28 || y > scroller.scrollTop + scroller.clientHeight - 28;
  }
  function scrollNowIntoView() {
    if (!cols.some((c) => c.key === todayKey)) return;
    if (nowMins < win.lo || nowMins > win.hi) {
      fitHours = false;
      return;
    }
    if (!scroller) return;
    const y = ((nowMins - win.lo) / 60) * HOUR;
    scroller.scrollTo({ top: Math.max(0, y - scroller.clientHeight * 0.35), behavior: "smooth" });
  }
  let seenReveal = calendar.revealNow;
  $effect(() => {
    const n = calendar.revealNow;
    if (n === seenReveal) return;
    seenReveal = n;
    tick().then(() => scrollNowIntoView());
  });
  $effect(() => {
    void nowMins;
    void win.lo;
    void win.hi;
    void todayKey;
    void cols.length;
    measureNow();
  });

  function style(ev: CalEvent): string {
    return `--c: ${calendar.colorOf(ev)}`;
  }
  const past = (ev: CalEvent) => ev.end <= toLocalIso(calendar.now);
  const yPx = (minsFromMidnight: number) => ((minsFromMidnight - win.lo) / 60) * HOUR;
</script>

<div class="tg" class:single={cols.length === 1} class:tz2={!!tz2}>
  <div class="head" style:--n={cols.length}>
    <div class="gutter tzh">
      {#if tz2}<span class="mono" title={tz2}>{tzLabel(tz2)}</span><span class="mono here">{tzLabel(Intl.DateTimeFormat().resolvedOptions().timeZone)}</span>{/if}
      <button class="fit mono" onclick={toggleFit} title={fitHours ? "Show the full day" : "Fit to working hours"}>{fitHours ? "24h" : "Fit"}</button>
    </div>
    {#each cols as c (c.key)}
      <button class="dh" class:today={c.key === todayKey} class:wkend={c.day.getDay() === 0 || c.day.getDay() === 6} onclick={() => calendar.goto(c.day, "day")}>
        <span class="dh-main">
          <span class="dow">{weekdayShort(c.day)}</span>
          <span class="num">{c.day.getDate()}</span>
        </span>
        {#if c.load > 0}<span class="load" style:--p={c.load} title={c.loadLabel}></span>{/if}
      </button>
    {/each}
  </div>

  {#if maxAllDay}
    <div class="allday" style:--n={cols.length}>
      <div class="gutter lbl mono">all day</div>
      {#each cols as c (c.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="adcell" class:today={c.key === todayKey} ondblclick={() => calendar.composeAt(c.day, null)}>
          {#each c.allDay.slice(0, openAllDay[c.key] ? c.allDay.length : ALLDAY_CAP) as e (e.id)}
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
          {#if !openAllDay[c.key] && c.allDay.length > ALLDAY_CAP}
            <button class="admore" onclick={() => (openAllDay[c.key] = true)}>+{c.allDay.length - ALLDAY_CAP}</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="scroll" bind:this={scroller} onscroll={measureNow}>
    <div class="canvas" style:height="{((win.hi - win.lo) / 60) * HOUR}px" style:--n={cols.length}>
      <div class="axis">
        {#each hours as h, i (h)}
          <div class="hr" style:top="{i * HOUR}px">{#if tz2}<span class="mono alt">{#if h}{tz2Labels[i]}{/if}</span>{/if}<span class="mono">{#if h}{pad(h)}:00{/if}</span></div>
        {/each}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="grid" bind:this={gridEl} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp}>
        {#each hours as h, i (h)}
          <div class="line" style:top="{i * HOUR}px"></div>
          <div class="line half" style:top="{i * HOUR + HOUR / 2}px"></div>
        {/each}
        {#each cols as c, ci (c.key)}
          {@const workTop = Math.max(ws, win.lo)}
          {@const workBot = Math.min(we, win.hi)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="col" class:today={c.key === todayKey} class:wkend={c.day.getDay() === 0 || c.day.getDay() === 6} onpointerdown={(e) => onColDown(e, ci)}>
            {#if workBot > workTop}<div class="work" style:top="{yPx(workTop)}px" style:height="{((workBot - workTop) / 60) * HOUR}px"></div>{/if}
            {#if !drag}
              {#each c.opens.filter((g) => g.top < win.hi && g.top + g.height > win.lo) as g (`${g.start}`)}
                <div class="open" style:top="{yPx(Math.max(g.top, win.lo))}px" style:height="{((Math.min(g.top + g.height, win.hi) - Math.max(g.top, win.lo)) / 60) * HOUR}px">
                  <button class="pill mono" title="Block as private focus time" onpointerdown={(e) => e.stopPropagation()} onclick={() => calendar.createFocusBlock(g.start, g.end)}>
                    <span>{hm(g.start)}–{hm(g.end)}</span>
                    <span class="act"><Shield size={10} /> Focus</span>
                  </button>
                </div>
              {/each}
            {/if}
            {#each c.placed as p (p.item.id)}
              {@const e = p.item}
              {@const b = box(p, ci)}
              {@const w = 100 / p.cols}
              {@const note = c.key === todayKey && !e.isCancelled && e.response !== "declined" ? clockNote(e, calendar.now) : null}
                <!-- Stays mounted while hidden: it holds the pointer capture during a cross-day drag. -->
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <div
                  class="ev"
                  class:hidden={b.hidden}
                  class:past={past(e) && note?.kind !== "live"}
                  class:live={note?.kind === "live"}
                  class:cancelled={e.isCancelled}
                  class:declined={e.response === "declined"}
                  class:tentative={e.response === "tentativelyAccepted" || e.showAs === "tentative"}
                  class:free={e.showAs === "free"}
                  class:ask={e.response === "notResponded"}
                  class:sel={calendar.selectedId === e.id}
                  class:dragging={drag && drag.kind !== "create" && drag.ev.id === e.id}
                  class:clash={!!(drag && drag.kind !== "create" && drag.ev.id === e.id && dragClash.length)}
                  class:short={b.height < 40}
                  class:tiny={b.height < 24}
                  class:editable={canEdit(e)}
                  style="{style(e)}; top: {yPx(b.top)}px; height: {(b.height / 60) * HOUR - 2}px; left: calc({p.col * w}% + 2px); width: calc({w}% - 4px);"
                  data-event-id={e.id}
                  onpointerdown={(pe) => onEvDown(pe, e, ci, p)}
                  role="button"
                  tabindex="-1">
                  <div class="t">
                    <span class="title">{e.subject || "(no title)"}</span>
                    {#if e.response === "notResponded" && !e.isCancelled}<CircleAlert size={11} class="warn" />{/if}
                    {#if calendar.notedIds.has(e.id)}<NotebookPen size={10} class="noted" />{/if}
                  </div>
                  <div class="m mono">
                    {#if note}<span class:left={note.kind === "live"} class:soon={note.kind === "soon"}>{note.text}</span>{:else}{hm(e.start)}–{hm(e.end)}{/if}
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
              <div class="ghost" class:bad={dragClash.length > 0} style:top="{yPx(ghost.top)}px" style:height="{(ghost.height / 60) * HOUR - 2}px">
                <span class="mono">{ghost.label}</span>
              </div>
            {/if}
            {#if cursor && cursor.col === ci}
              <button class="cursor" style:top="{yPx(cursor.mins)}px" style:height="{(cursor.len / 60) * HOUR - 2}px" onclick={() => calendar.composeAtCursor()} title="Enter: new event here">
                <span class="mono">{lbl(cursor.mins)}–{lbl(cursor.mins + cursor.len)}</span>
                <span class="hintk"><kbd>↵</kbd> new</span>
              </button>
            {/if}
            {#if c.key === todayKey && nowMins >= win.lo && nowMins <= win.hi}
              <div class="now" style:top="{yPx(nowMins)}px"><span class="dot"></span></div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
  {#if nowHidden && !drag}
    <button class="nowjump" onclick={scrollNowIntoView}><span class="dot"></span> Now</button>
  {/if}
  {#if drag}
    <div class="hint mono" class:bad={dragClash.length > 0}>
      {#if drag.kind === "create"}New event {lbl(drag.from)}–{lbl(drag.to)} · {durationLabel("2000-01-01T00:00:00", `2000-01-01T${lbl(drag.to - drag.from)}:00`)}{:else if drag.kind === "move"}{lbl(drag.top)}–{lbl(drag.top + drag.dur)}{:else}{lbl(drag.top)}–{lbl(drag.bottom)}{/if}
      {#if dragClash.length} · overlaps {dragClash.slice(0, 2).join(", ")}{dragClash.length > 2 ? ` +${dragClash.length - 2}` : ""}{/if}
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
  .tg.tz2 {
    --gutter: 96px;
  }
  .tzh {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: flex-end;
    gap: 4px;
    padding: 0 6px 6px 0;
    font-size: 9.5px;
    color: var(--muted);
  }
  .tzh .here {
    color: var(--fg-dim);
  }
  .hr .alt {
    color: color-mix(in oklab, var(--muted) 70%, transparent);
    margin-right: 8px;
  }
  .t :global(.noted) {
    flex: none;
    color: color-mix(in oklab, var(--yellow) 85%, var(--fg));
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
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 8px 4px 7px;
    border-left: 1px solid var(--line);
    transition: background var(--t);
  }
  .dh-main {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .load {
    width: 28px;
    height: 2px;
    border-radius: 99px;
    background: color-mix(in oklab, var(--fg) 12%, transparent);
    position: relative;
  }
  .load::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--p) * 100%);
    border-radius: inherit;
    background: color-mix(in oklab, var(--accent) calc(100% - var(--p) * 55%), var(--red));
  }
  .fit {
    height: 16px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 9px;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .fit:hover {
    color: var(--fg);
    background: var(--hover);
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
  .admore {
    height: 18px;
    padding: 0 7px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--muted);
    text-align: left;
  }
  .admore:hover {
    color: var(--fg);
    background: var(--hover);
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
  .open {
    position: absolute;
    left: 5px;
    right: 5px;
    overflow: hidden;
    border-radius: 8px;
    background: repeating-linear-gradient(-45deg, transparent, transparent 7px, color-mix(in oklab, var(--green) 7%, transparent) 7px, color-mix(in oklab, var(--green) 7%, transparent) 8px);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--green) 16%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 0;
  }
  .pill {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 10px;
    color: color-mix(in oklab, var(--green) 80%, var(--fg));
    background: color-mix(in oklab, var(--surface) 82%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--green) 28%, transparent);
  }
  .pill .act {
    display: none;
    align-items: center;
    gap: 3px;
  }
  .pill:hover .act,
  .pill:focus-visible .act {
    display: inline-flex;
  }
  .pill:hover,
  .pill:focus-visible {
    color: var(--fg-bright);
    background: var(--surface);
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
  .ev.clash {
    box-shadow: inset 0 0 0 1.5px var(--red), 0 0 0 3px color-mix(in oklab, var(--red) 22%, transparent);
  }
  .ev.live {
    opacity: 1;
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--c) 50%, transparent), 0 0 0 1px color-mix(in oklab, var(--red) 45%, transparent);
  }
  .m .left {
    color: var(--red);
    font-weight: 650;
  }
  .m .soon {
    color: var(--yellow);
    font-weight: 650;
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
  .ghost.bad {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 16%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--red) 55%, transparent);
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
    white-space: nowrap;
  }
  .hint.bad {
    color: var(--red);
  }
  .nowjump {
    position: absolute;
    right: 16px;
    bottom: 14px;
    z-index: 8;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px 0 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 650;
    color: var(--fg-bright);
    background: var(--raised);
    box-shadow: var(--shadow-sm);
  }
  .nowjump .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
  }
  .single .dh {
    align-items: flex-start;
    padding-left: 14px;
  }
  @container calendar (max-width: 600px) {
    .dh { flex-direction: column; align-items: center; gap: 2px; padding-inline: 0; }
    .dow { font-size: 9px; letter-spacing: 0; }
    .num { font-size: 15px; min-width: 22px; padding-inline: 2px; }
  }
</style>
