<script lang="ts">
  // Agenda: the next 7 days as a list, with free-gap hints and keyboard navigation (j/k, Enter).
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { dayLabel, dateLabel, freeGaps, hm, isPast, dayKey } from "$lib/util/cal";
  import EventRow from "./EventRow.svelte";
  import Logo from "./Logo.svelte";
  import { CalendarDays, Plus, RefreshCw, LoaderCircle, Sparkles } from "@lucide/svelte";
  import { agent } from "$lib/state/agent.svelte";

  $effect(() => {
    if (app.view.kind === "agenda" && !calendar.loadedOnce) calendar.load();
  });

  const days = $derived(calendar.byDay(7));
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

  /** Gaps shown between rows: index of the timed event the gap precedes → gap. A gap after the last event uses key "end". */
  function gapMap(dayEvents: typeof days[number]["events"], day: Date) {
    const map = new Map<string, { mins: number; start: string; end: string }>();
    const timed = dayEvents.filter((e) => !e.isAllDay);
    for (const g of freeGaps(dayEvents, day, ws, we, 60)) {
      // Skip gaps that are already over today.
      if (dayKey(day) === todayKey && isPast({ end: g.end }, calendar.now)) continue;
      const next = timed.find((e) => e.start >= g.end);
      map.set(next ? next.id : "end", g);
    }
    return map;
  }

  function ask(q: string) {
    app.toggleAgent(true);
    agent.send(q);
  }
</script>

<section class="agenda">
  <div class="scroll">
    <div class="canvas">
      <header class="hero">
        <div>
          <div class="eyebrow">Next 7 days</div>
          <h1>Calendar</h1>
          <div class="stats">
            {#if calendar.loading && !calendar.loadedOnce}
              <span class="shimmer-text">Loading your calendar…</span>
            {:else}
              {total} event{total === 1 ? "" : "s"}
              {#if calendar.unanswered.length}<span class="sep">·</span><span class="warn">{calendar.unanswered.length} invitation{calendar.unanswered.length === 1 ? "" : "s"} to answer</span>{/if}
              {#if calendar.loading}<span class="sep">·</span><LoaderCircle size={12} class="spin" />{/if}
            {/if}
          </div>
        </div>
        <div class="actions">
          {#if app.aiReady}
            <button class="btn" onclick={() => ask("Find 30 min with ")}><Sparkles size={13} /> Find a time</button>
          {/if}
          <button class="btn" onclick={() => calendar.refresh()} title="Refresh"><RefreshCw size={13} /></button>
          <button class="btn primary" onclick={() => calendar.openComposer()}><Plus size={14} /> New event <kbd>n</kbd></button>
        </div>
      </header>

      {#if calendar.loadedOnce && !total}
        <div class="empty">
          <div class="mark"><Logo size={40} /></div>
          <h2>A clear week</h2>
          <p>Nothing on the calendar for the next seven days.</p>
        </div>
      {/if}

      {#each days as { day, events }, di (dayKey(day))}
        {@const key = dayKey(day)}
        {@const isToday = key === todayKey}
        {@const gaps = gapMap(events, day)}
        {@const overlapIds = calendar.overlapIds(events)}
        {@const allDay = events.filter((e) => e.isAllDay)}
        {@const timed = events.filter((e) => !e.isAllDay)}
        {#if events.length || isToday}
          <section class="dayblock" class:today={isToday} style:--i={di}>
            <div class="dayhead">
              <span class="dow" class:accent={isToday}>{dayLabel(day, calendar.now)}</span>
              <span class="date mono">{dateLabel(day)}</span>
              {#if isToday && !events.length}<span class="muted">— nothing scheduled</span>{/if}
            </div>
            {#if events.length}
              <div class="card">
                {#if allDay.length}
                  <div class="allday">
                    {#each allDay as e (e.id)}
                      <button class="adchip" class:cancelled={e.isCancelled} onclick={() => calendar.openDetails(e.id)}>{e.subject || "(no title)"}</button>
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
        <span><kbd>n</kbd> new event</span>
        <span><kbd>g</kbd><kbd>t</kbd> today</span>
      </div>
    </div>
  </div>
</section>

<style>
  .agenda {
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(900px 400px at 85% -10%, color-mix(in oklab, var(--accent) 9%, transparent), transparent 70%),
      var(--surface);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .canvas {
    max-width: 920px;
    margin: 0 auto;
    padding: 28px 40px 80px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 4px 4px;
    animation: fade-up 240ms var(--ease);
  }
  h1 {
    margin: 6px 0 0;
    font-size: 28px;
    line-height: 1.15;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--fg-bright);
  }
  .stats {
    margin-top: 8px;
    font-size: 13px;
    color: var(--fg-dim);
    display: flex;
    align-items: center;
    gap: 0;
  }
  .sep {
    margin: 0 6px;
    color: var(--muted);
  }
  .warn {
    color: var(--red);
  }
  .actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .actions kbd {
    margin-left: 4px;
  }
  .dayblock {
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: fade-up 240ms var(--ease) both;
    animation-delay: calc(var(--i, 0) * 30ms);
  }
  .dayhead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 0 4px;
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
    background: color-mix(in oklab, var(--blue) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--blue) 30%, transparent);
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
    margin: 0;
    font-size: 13px;
  }
  .hint-row {
    display: flex;
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
      padding: 22px 22px 60px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dayblock,
    .hero {
      animation: none;
    }
  }
</style>
