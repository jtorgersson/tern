<script lang="ts">
  // Insights: how your time actually went. KPI tiles (vs. your 4-week baseline), a 12-week meeting heatmap,
  // when meetings happen, who you meet most, meeting sizes, and an AI time coach.
  // Charts follow one rule set: a single sequential accent hue for magnitude, text in text tokens, per-mark tooltips,
  // a table view for every number.
  import { app } from "$lib/state/app.svelte";
  import { calendar, INSIGHT_WEEKS } from "$lib/state/calendar.svelte";
  import { computeInsights, fmtMins, heatBin, type DayStat } from "$lib/util/insights";
  import { coachInsights, isAbort } from "$lib/ai";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { dayKey, initialsOf, addDays } from "$lib/util/cal";
  import { isoWeek, weekdayDayMonth, weekdayShort, dayMonth } from "$lib/util/fmt";
  import { errMsg } from "$lib/util/misc";
  import { Sparkles, TrendingUp, TrendingDown, Minus, Table2, ChartColumn, LoaderCircle, RefreshCw } from "@lucide/svelte";

  const ws = $derived(app.settings?.calendar.workStart ?? "09:00");
  const we = $derived(app.settings?.calendar.workEnd ?? "17:00");
  const mine = $derived(app.accounts.map((a) => a.email));
  const data = $derived(computeInsights(calendar.visible, calendar.anchor, mine, ws, we, INSIGHT_WEEKS));
  const todayKey = $derived(dayKey(calendar.now));
  const loading = $derived(calendar.fetching || (calendar.loading && !calendar.loadedOnce));
  let tableView = $state(false);

  // ---- KPI tiles ----
  interface Tile {
    label: string;
    value: string;
    delta: number;
    base: string;
    /** Is "up" good for this measure? */
    upIsGood: boolean;
    hint: string;
  }
  const tiles = $derived.by<Tile[]>(() => {
    const c = data.current;
    const b = data.baseline;
    return [
      { label: "Time in meetings", value: fmtMins(c.meetingMins), delta: c.meetingMins - b.meetingMins, base: fmtMins(b.meetingMins), upIsGood: false, hint: "Merged meeting time with at least one other person" },
      { label: "Focus time", value: fmtMins(c.focusMins), delta: c.focusMins - b.focusMins, base: fmtMins(b.focusMins), upIsGood: true, hint: `Free blocks of an hour or more within ${ws}–${we}, Mon–Fri` },
      { label: "Meetings", value: String(c.meetings), delta: c.meetings - b.meetings, base: String(b.meetings), upIsGood: false, hint: "Timed, not declined or cancelled" },
      { label: "Back-to-back", value: String(c.backToBack), delta: c.backToBack - b.backToBack, base: String(b.backToBack), upIsGood: false, hint: `Meetings starting within 5 min of the previous one. Longest run this week: ${fmtMins(data.longestChainMins)}` },
    ];
  });
  function deltaText(t: Tile): string {
    if (t.delta === 0) return "same as usual";
    const v = t.label.startsWith("Time") || t.label.startsWith("Focus") ? fmtMins(Math.abs(t.delta)) : String(Math.abs(t.delta));
    return `${t.delta > 0 ? "+" : "−"}${v} vs usual ${t.base}`;
  }

  // ---- tooltip (one shared, follows the pointer) ----
  let tip = $state<{ x: number; y: number; title: string; body: string } | null>(null);
  function showTip(e: PointerEvent | FocusEvent, title: string, body: string) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    tip = { x: r.left + r.width / 2, y: r.top, title, body };
  }
  const hideTip = () => (tip = null);

  // ---- heatmap ----
  const rows = [0, 1, 2, 3, 4, 5, 6];
  function cellTitle(d: DayStat) {
    return weekdayDayMonth(d.day);
  }
  function cellBody(d: DayStat) {
    return d.meetings ? `${fmtMins(d.meetingMins)} in ${d.meetings} meeting${d.meetings === 1 ? "" : "s"}` : "No meetings";
  }

  // ---- hour histogram (only hours that have anything, padded to working hours) ----
  const hourRange = $derived.by(() => {
    const [a] = ws.split(":").map(Number);
    const [b] = we.split(":").map(Number);
    let lo = Math.min(a || 9, ...data.byHour.map((v, h) => (v ? h : 24)));
    let hi = Math.max((b || 17) - 1, ...data.byHour.map((v, h) => (v ? h : 0)));
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  });
  const hourMax = $derived(Math.max(1, ...data.byHour));
  const peakHour = $derived(data.byHour.indexOf(Math.max(...data.byHour)));
  const quietHour = $derived.by(() => {
    const [a] = ws.split(":").map(Number);
    const [b] = we.split(":").map(Number);
    let best = a || 9;
    for (let h = a || 9; h < (b || 17); h++) if (data.byHour[h] < data.byHour[best]) best = h;
    return best;
  });
  const pad = (n: number) => String(n).padStart(2, "0");

  // ---- people & sizes ----
  const peopleMax = $derived(Math.max(1, ...data.people.map((p) => p.mins)));
  const sizeRows = $derived([
    { label: "1:1", n: data.sizes.oneOnOne },
    { label: "Small group (3–6)", n: data.sizes.small },
    { label: "Large (7+)", n: data.sizes.large },
  ]);
  const sizeMax = $derived(Math.max(1, ...sizeRows.map((r) => r.n)));
  const totalMeetings = $derived(data.sizes.oneOnOne + data.sizes.small + data.sizes.large);

  // ---- AI coach ----
  let coach = $state("");
  let coachBusy = $state(false);
  let coachErr = $state<string | null>(null);
  let ctrl: AbortController | null = null;
  async function runCoach() {
    ctrl?.abort();
    const c = new AbortController();
    ctrl = c;
    coachBusy = true;
    coachErr = null;
    coach = "";
    const stats = {
      week: `ISO week ${isoWeek(calendar.anchor)}`,
      workingHours: `${ws}–${we}`,
      thisWeek: { meetings: fmtMins(data.current.meetingMins), focus: fmtMins(data.current.focusMins), meetingCount: data.current.meetings, backToBack: data.current.backToBack, longestBackToBackRun: fmtMins(data.longestChainMins) },
      usualWeek: { meetings: fmtMins(data.baseline.meetingMins), focus: fmtMins(data.baseline.focusMins), meetingCount: data.baseline.meetings, backToBack: data.baseline.backToBack },
      thisWeekByDay: data.weeks[data.weeks.length - 1].days.map((d) => ({ day: weekdayShort(d.day), meetings: fmtMins(d.meetingMins), count: d.meetings })),
      meetingMinutesByHour12Weeks: Object.fromEntries(hourRange.map((h) => [`${pad(h)}:00`, data.byHour[h]])),
      topPeople12Weeks: data.people.slice(0, 6).map((p) => ({ name: p.name, meetings: p.meetings, time: fmtMins(p.mins) })),
      meetingSizes12Weeks: data.sizes,
    };
    let acc = "";
    try {
      for await (const d of coachInsights(stats, c.signal)) {
        if (c.signal.aborted) break;
        acc += d;
        coach = acc;
      }
    } catch (e) {
      if (!isAbort(e) && !c.signal.aborted) coachErr = errMsg(e);
    } finally {
      if (ctrl === c) coachBusy = false;
    }
  }
  // Reset the coach when the period moves.
  $effect(() => {
    void dayKey(calendar.period.from);
    ctrl?.abort();
    coach = "";
    coachErr = null;
  });

  const weekRange = $derived(`${dayMonth(data.current.start)} – ${dayMonth(addDays(data.current.start, 6))}`);
</script>

<div class="scroll">
  <div class="canvas">
    <header class="hero">
      <div>
        <div class="eyebrow">Week {isoWeek(calendar.anchor)} · {weekRange}</div>
        <h2>How your time went</h2>
        <p class="sub">Compared with your average of the four weeks before. {#if loading}<LoaderCircle size={12} class="spin" /> loading history…{/if}</p>
      </div>
      <div class="hero-actions">
        <button class="btn sm" onclick={() => (tableView = !tableView)} aria-pressed={tableView}>
          {#if tableView}<ChartColumn size={13} /> Charts{:else}<Table2 size={13} /> Table{/if}
        </button>
        {#if app.aiReady}
          <button class="btn sm primary" onclick={runCoach} disabled={coachBusy}>{#if coachBusy}<LoaderCircle size={13} class="spin" />{:else}<Sparkles size={13} />{/if} Coach me</button>
        {/if}
      </div>
    </header>

    {#if coach || coachBusy || coachErr}
      <section class="coach" aria-live="polite">
        <div class="ch"><Sparkles size={13} /> Time coach {#if coach && !coachBusy}<button class="mini" onclick={runCoach} title="Again"><RefreshCw size={11} /></button>{/if}</div>
        {#if coachErr}
          <div class="err">{coachErr}</div>
        {:else if coach}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="md" class:streaming={coachBusy} onclick={mdLinkHandler}>{@html md(coach)}</div>
        {:else}
          <div class="skeleton"><span style:width="65%"></span><span style:width="85%"></span><span style:width="50%"></span></div>
        {/if}
      </section>
    {/if}

    <section class="tiles">
      {#each tiles as t, i (t.label)}
        {@const good = t.delta === 0 ? null : t.delta > 0 === t.upIsGood}
        <div class="tile" style:--i={i} title={t.hint}>
          <div class="tl">{t.label}</div>
          <div class="tv">{t.value}</div>
          <div class="td" class:good={good === true} class:bad={good === false}>
            {#if t.delta > 0}<TrendingUp size={12} />{:else if t.delta < 0}<TrendingDown size={12} />{:else}<Minus size={12} />{/if}
            <span>{deltaText(t)}</span>
          </div>
        </div>
      {/each}
    </section>

    {#if tableView}
      <section class="card">
        <div class="ct">Week by week</div>
        <table class="tbl">
          <thead><tr><th>Week</th><th>Starts</th><th class="r">Meetings</th><th class="r">Time in meetings</th><th class="r">Focus time</th><th class="r">Back-to-back</th></tr></thead>
          <tbody>
            {#each [...data.weekly].reverse() as w (dayKey(w.start))}
              <tr class:cur={w === data.current}>
                <td class="mono">{isoWeek(w.start)}</td><td>{dayMonth(w.start)}</td><td class="r mono">{w.meetings}</td><td class="r mono">{fmtMins(w.meetingMins)}</td><td class="r mono">{fmtMins(w.focusMins)}</td><td class="r mono">{w.backToBack}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="ct sp">People you meet most (12 weeks)</div>
        <table class="tbl">
          <thead><tr><th>Person</th><th class="r">Meetings</th><th class="r">Time</th></tr></thead>
          <tbody>
            {#each data.people as p (p.email)}<tr><td>{p.name}</td><td class="r mono">{p.meetings}</td><td class="r mono">{fmtMins(p.mins)}</td></tr>{/each}
          </tbody>
        </table>
      </section>
    {:else}
      <section class="card">
        <div class="ct">
          Meeting load, last {INSIGHT_WEEKS} weeks
          <span class="legend" aria-hidden="true">less {#each [0, 1, 2, 3, 4] as b (b)}<span class="lg b{b}"></span>{/each} more</span>
        </div>
        <div class="heat" role="grid" aria-label="Meeting time per day for the last {INSIGHT_WEEKS} weeks">
          <div class="rowlbls">
            <span></span>
            {#each rows as r (r)}<span class="rl">{r % 2 === 0 ? weekdayShort(data.weeks[0].days[r].day) : ""}</span>{/each}
          </div>
          {#each data.weeks as w, wi (dayKey(w.start))}
            <div class="wcol" class:cur={wi === data.weeks.length - 1}>
              <span class="wn mono">{wi % 2 === (data.weeks.length - 1) % 2 ? isoWeek(w.start) : ""}</span>
              {#each w.days as d (d.key)}
                {@const bin = heatBin(d.meetingMins, data.maxDayMins)}
                <button
                  class="cell b{bin}"
                  class:today={d.key === todayKey}
                  class:future={d.day > calendar.now}
                  style:--d="{wi * 18 + d.day.getDay() * 6}ms"
                  aria-label="{cellTitle(d)}: {cellBody(d)}"
                  onpointerenter={(e) => showTip(e, cellTitle(d), cellBody(d))}
                  onpointerleave={hideTip}
                  onfocus={(e) => showTip(e, cellTitle(d), cellBody(d))}
                  onblur={hideTip}
                  onclick={() => calendar.goto(d.day, "day")}></button>
              {/each}
            </div>
          {/each}
        </div>
      </section>

      <div class="two">
        <section class="card">
          <div class="ct">When your meetings happen</div>
          <div class="hours" role="list" aria-label="Meeting minutes by hour of day">
            {#each hourRange as h (h)}
              {@const v = data.byHour[h]}
              <div class="hcol" role="listitem">
                <button
                  class="hbar"
                  class:peak={h === peakHour && v > 0}
                  style:height="{Math.max(v ? 4 : 0, (v / hourMax) * 100)}%"
                  aria-label="{pad(h)}:00–{pad(h + 1)}:00: {fmtMins(v)}"
                  onpointerenter={(e) => showTip(e, `${pad(h)}:00–${pad(h + 1)}:00`, `${fmtMins(v)} of meetings over ${INSIGHT_WEEKS} weeks`)}
                  onpointerleave={hideTip}
                  onfocus={(e) => showTip(e, `${pad(h)}:00–${pad(h + 1)}:00`, `${fmtMins(v)} of meetings`)}
                  onblur={hideTip}></button>
                <span class="hl mono">{h % 2 === 0 ? pad(h) : ""}</span>
              </div>
            {/each}
          </div>
          {#if data.byHour.some((v) => v)}
            <p class="note">Busiest at <b>{pad(peakHour)}:00</b>; quietest working hour is <b>{pad(quietHour)}:00</b> — a good slot to protect.</p>
          {/if}
        </section>

        <section class="card">
          <div class="ct">Meeting size <span class="muted mono">{totalMeetings} meetings</span></div>
          <div class="hbars">
            {#each sizeRows as r (r.label)}
              <div class="hrow">
                <span class="hn">{r.label}</span>
                <span class="track"><span class="fill" style:width="{(r.n / sizeMax) * 100}%" onpointerenter={(e) => showTip(e, r.label, `${r.n} meetings · ${totalMeetings ? Math.round((r.n / totalMeetings) * 100) : 0}%`)} onpointerleave={hideTip} role="img" aria-label="{r.label}: {r.n}"></span></span>
                <span class="hv mono">{r.n}</span>
              </div>
            {/each}
          </div>
        </section>
      </div>

      {#if data.people.length}
        <section class="card">
          <div class="ct">People you meet most <span class="muted">last {INSIGHT_WEEKS} weeks</span></div>
          <div class="hbars people">
            {#each data.people as p, i (p.email)}
              <div class="hrow" style:--i={i}>
                <span class="hn person"><span class="av">{initialsOf(p.name, p.email)}</span><span class="pn" title={p.email}>{p.name}</span></span>
                <span class="track"><span class="fill" style:width="{(p.mins / peopleMax) * 100}%" onpointerenter={(e) => showTip(e, p.name, `${p.meetings} meeting${p.meetings === 1 ? "" : "s"} · ${fmtMins(p.mins)}`)} onpointerleave={hideTip} role="img" aria-label="{p.name}: {fmtMins(p.mins)}"></span></span>
                <span class="hv mono">{fmtMins(p.mins)}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>
</div>

{#if tip}
  <div class="tip" style:left="{tip.x}px" style:top="{tip.y}px" role="tooltip">
    <div class="tt">{tip.title}</div>
    <div class="tb">{tip.body}</div>
  </div>
{/if}

<style>
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .canvas {
    max-width: 980px;
    margin: 0 auto;
    padding: 22px 36px 80px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    animation: fade-up 260ms var(--ease);
  }
  h2 {
    margin: 4px 0 0;
    font-size: 26px;
    font-weight: 720;
    letter-spacing: -0.03em;
    color: var(--fg-bright);
  }
  .sub {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--fg-dim);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hero-actions {
    display: flex;
    gap: 6px;
  }
  /* ---- coach ---- */
  .coach {
    padding: 12px 14px;
    border-radius: 14px;
    background: linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, transparent), transparent 70%);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 24%, var(--line));
    animation: fade-up 220ms var(--ease);
  }
  .ch {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .coach .md {
    font-size: 13px;
    line-height: 1.55;
    color: var(--fg);
  }
  .coach .md :global(p) {
    margin: 0 0 4px;
  }
  .coach .md :global(ul) {
    margin: 2px 0;
    padding-left: 18px;
  }
  .coach .md.streaming :global(:is(p, li):last-child)::after {
    content: "▍";
    color: var(--accent);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .mini {
    display: grid;
    margin-left: 4px;
    color: var(--muted);
  }
  .err {
    font-size: 12.5px;
    color: var(--red);
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .skeleton span {
    height: 10px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--hover) 25%, color-mix(in oklab, var(--accent) 18%, transparent) 50%, var(--hover) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }
  /* ---- KPI tiles ---- */
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .tile {
    padding: 14px 16px 12px;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    animation: fade-up 280ms var(--ease) both;
    animation-delay: calc(var(--i) * 50ms);
  }
  .tl {
    font-size: 12px;
    color: var(--fg-dim);
  }
  .tv {
    margin-top: 4px;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--fg-bright);
    font-variant-numeric: tabular-nums;
  }
  .td {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--muted);
  }
  /* Delta direction is carried by icon + text; colour only reinforces it. */
  .td.good {
    color: var(--green);
  }
  .td.bad {
    color: var(--orange);
  }
  /* ---- cards ---- */
  .card {
    padding: 14px 16px 16px;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    animation: fade-up 300ms var(--ease) both;
  }
  .ct {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 650;
    color: var(--fg-bright);
    margin-bottom: 12px;
  }
  .ct.sp {
    margin-top: 18px;
  }
  .muted {
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
  }
  .two {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 16px;
  }
  /* ---- heatmap: one sequential hue (accent), 5 steps; 2px surface gaps ---- */
  .heat {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .rowlbls,
  .wcol {
    display: grid;
    grid-template-rows: 16px repeat(7, 1fr);
    gap: 2px;
  }
  .rowlbls {
    padding-right: 6px;
  }
  .rl {
    font-size: 10px;
    color: var(--muted);
    display: flex;
    align-items: center;
  }
  .wcol {
    flex: 1;
    min-width: 22px;
  }
  .wn {
    font-size: 9.5px;
    color: var(--muted);
    text-align: center;
  }
  .wcol.cur .wn {
    color: var(--accent);
    font-weight: 700;
  }
  .cell {
    aspect-ratio: 1;
    min-height: 18px;
    border-radius: 4px;
    animation: pop 420ms var(--ease) both;
    animation-delay: var(--d);
    transition: transform 120ms var(--ease), box-shadow 120ms;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.4);
    }
  }
  .cell:hover,
  .cell:focus-visible {
    transform: scale(1.18);
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent);
    z-index: 1;
    outline: none;
  }
  .b0 {
    background: color-mix(in oklab, var(--fg) 6%, transparent);
  }
  .b1 {
    background: color-mix(in oklab, var(--accent) 28%, var(--bg));
  }
  .b2 {
    background: color-mix(in oklab, var(--accent) 50%, var(--bg));
  }
  .b3 {
    background: color-mix(in oklab, var(--accent) 74%, var(--bg));
  }
  .b4 {
    background: var(--accent);
  }
  .cell.future {
    opacity: 0.55;
  }
  .cell.today {
    box-shadow: 0 0 0 1.5px var(--fg-bright);
  }
  .legend {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--muted);
  }
  .lg {
    width: 11px;
    height: 11px;
    border-radius: 3px;
  }
  /* ---- hour columns ---- */
  .hours {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 140px;
    padding-top: 6px;
    border-bottom: 1px solid var(--line);
  }
  .hcol {
    flex: 1;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: stretch;
    position: relative;
  }
  .hbar {
    width: 100%;
    border-radius: 4px 4px 0 0;
    background: color-mix(in oklab, var(--accent) 55%, var(--bg));
    transform-origin: bottom;
    animation: grow 500ms var(--ease) both;
    transition: background var(--t);
  }
  .hbar.peak {
    background: var(--accent);
  }
  .hbar:hover,
  .hbar:focus-visible {
    background: color-mix(in oklab, var(--accent) 85%, white);
    outline: none;
  }
  @keyframes grow {
    from {
      transform: scaleY(0);
    }
  }
  .hl {
    position: absolute;
    bottom: -18px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 9.5px;
    color: var(--muted);
  }
  .note {
    margin: 26px 0 0;
    font-size: 12px;
    color: var(--fg-dim);
  }
  .note b {
    color: var(--fg-bright);
    font-weight: 650;
  }
  /* ---- horizontal bars ---- */
  .hbars {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hrow {
    display: grid;
    grid-template-columns: minmax(110px, 180px) 1fr 64px;
    align-items: center;
    gap: 10px;
    animation: fade-up 280ms var(--ease) both;
    animation-delay: calc(var(--i, 0) * 40ms);
  }
  .hn {
    font-size: 12.5px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .person {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .av {
    flex: none;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-size: 9px;
    font-weight: 700;
    color: var(--fg);
    background: color-mix(in oklab, var(--accent) 22%, transparent);
  }
  .pn {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .track {
    height: 10px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--fg) 6%, transparent);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
    transform-origin: left;
    animation: grow-x 600ms var(--ease) both;
  }
  @keyframes grow-x {
    from {
      transform: scaleX(0);
    }
  }
  .hv {
    font-size: 11.5px;
    color: var(--fg-dim);
    text-align: right;
  }
  /* ---- table ---- */
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  .tbl th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
  }
  .tbl td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    color: var(--fg);
  }
  .tbl .r {
    text-align: right;
  }
  .tbl tr.cur td {
    color: var(--fg-bright);
    font-weight: 600;
    background: var(--accent-soft);
  }
  /* ---- tooltip ---- */
  .tip {
    position: fixed;
    z-index: 60;
    transform: translate(-50%, calc(-100% - 8px));
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--raised);
    box-shadow: var(--shadow-sm);
    pointer-events: none;
    white-space: nowrap;
  }
  .tt {
    font-size: 11.5px;
    font-weight: 650;
    color: var(--fg-bright);
  }
  .tb {
    font-size: 11px;
    color: var(--fg-dim);
  }
  @media (max-width: 1100px) {
    .tiles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .two {
      grid-template-columns: 1fr;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .cell,
    .hbar,
    .fill,
    .tile,
    .card,
    .hrow {
      animation: none;
    }
  }
</style>
