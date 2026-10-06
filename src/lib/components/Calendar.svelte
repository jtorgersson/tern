<script lang="ts">
  // Calendar canvas: toolbar (period navigation, view switch, quick add), left rail (mini month, calendars,
  // open invitations) and the active view (day / week / month / agenda).
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { agent } from "$lib/state/agent.svelte";
  import type { CalView } from "$lib/types";
  import { parseQuickAdd } from "$lib/util/quickadd";
  import { whenLabel, recurrenceLabel, presetRecurrence } from "$lib/util/cal";
  import MiniMonth from "./MiniMonth.svelte";
  import TimeGrid from "./TimeGrid.svelte";
  import MonthGrid from "./MonthGrid.svelte";
  import AgendaList from "./AgendaList.svelte";
  import { ChevronLeft, ChevronRight, Plus, RefreshCw, LoaderCircle, Sparkles, Zap, CalendarCheck, Check, Eye, EyeOff, PanelLeftClose, PanelLeftOpen } from "@lucide/svelte";
  import { tick } from "svelte";

  const VIEWS: { id: CalView; label: string; key: string }[] = [
    { id: "day", label: "Day", key: "d" },
    { id: "week", label: "Week", key: "w" },
    { id: "month", label: "Month", key: "m" },
    { id: "agenda", label: "Agenda", key: "a" },
  ];

  $effect(() => {
    if (app.view.kind === "calendar") {
      calendar.applyDefaultView();
      if (!calendar.loadedOnce) calendar.load();
      else calendar.ensurePeriod();
      if (!calendar.calendars.length) calendar.loadCalendars();
    }
  });

  let quick = $state("");
  let quickEl: HTMLInputElement | undefined = $state();
  const parsed = $derived(quick.trim() ? parseQuickAdd(quick, calendar.now, app.settings?.calendar.defaultDurationMins ?? 30) : null);
  const preview = $derived.by(() => {
    if (!parsed) return "";
    const bits = [whenLabel({ start: isoOf(parsed.start), end: isoOf(parsed.end), isAllDay: parsed.allDay })];
    if (parsed.repeat !== "none") bits.push(recurrenceLabel(presetRecurrence(parsed.repeat, parsed.start)).toLowerCase());
    if (parsed.location) bits.push(`@ ${parsed.location}`);
    if (parsed.isOnline) bits.push("Teams");
    return bits.join(" · ");
  });
  function isoOf(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
  }
  function submitQuick() {
    if (calendar.quickAdd(quick)) {
      quick = "";
      quickEl?.blur();
    }
  }
  function onQuickKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitQuick();
    } else if (e.key === "Escape") {
      quick = "";
      quickEl?.blur();
    }
    e.stopPropagation();
  }

  let railOpen = $state(true);
  try {
    railOpen = localStorage.getItem("tern.calRail") !== "0";
  } catch {}
  function toggleRail() {
    railOpen = !railOpen;
    try {
      localStorage.setItem("tern.calRail", railOpen ? "1" : "0");
    } catch {}
  }

  const upcomingInvites = $derived(calendar.unanswered.slice(0, 5));
  const calsByAccount = $derived.by(() => {
    const m = new Map<string, typeof calendar.calendars>();
    for (const c of calendar.visibleCalendars) m.set(c.accountId, [...(m.get(c.accountId) ?? []), c]);
    return [...m.entries()];
  });

  function ask(q: string) {
    app.toggleAgent(true);
    agent.send(q);
  }
  function briefPeriod() {
    const { from, to } = calendar.period;
    const f = isoOf(from).slice(0, 10);
    const t = isoOf(new Date(to.getTime() - 1)).slice(0, 10);
    ask(`Brief me on my calendar ${f} to ${t}: the shape of each day, anything overlapping or unanswered, and where I have focus time. Use list_events.`);
  }

  export function focusQuick() {
    tick().then(() => quickEl?.focus());
  }
</script>

<section class="cal" class:rail-closed={!railOpen}>
  <header class="toolbar">
    <div class="nav">
      <button class="icon-btn" onclick={toggleRail} title={railOpen ? "Hide sidebar" : "Show sidebar"}>
        {#if railOpen}<PanelLeftClose size={15} />{:else}<PanelLeftOpen size={15} />{/if}
      </button>
      <button class="btn sm today" class:on={calendar.isTodayVisible} onclick={() => calendar.today()} title="Go to today (t)">Today</button>
      <div class="arrows">
        <button class="icon-btn" onclick={() => calendar.prev()} title="Previous (h / ←)"><ChevronLeft size={16} /></button>
        <button class="icon-btn" onclick={() => calendar.next()} title="Next (l / →)"><ChevronRight size={16} /></button>
      </div>
      <h1>
        {calendar.title}
        {#if calendar.showWeekNumbers && calendar.weekLabel}<span class="wk mono">{calendar.weekLabel}</span>{/if}
        {#if calendar.loading || calendar.fetching}<LoaderCircle size={13} class="spin" />{/if}
      </h1>
    </div>

    <div class="quick" class:has={!!parsed}>
      <Zap size={13} />
      <input bind:this={quickEl} bind:value={quick} placeholder="Quick add: “Lunch with Anna tomorrow 12”, “Styrelsemöte fre 14-15:30”…" onkeydown={onQuickKey} />
      {#if parsed}
        <span class="qp mono">{preview}</span>
        <button class="btn sm primary" onclick={submitQuick}>Add</button>
      {/if}
    </div>

    <div class="right">
      <div class="seg">
        {#each VIEWS as v (v.id)}
          <button class:on={calendar.view === v.id} onclick={() => calendar.setView(v.id)} title="{v.label} ({v.key})">{v.label}</button>
        {/each}
      </div>
      {#if app.aiReady}
        <button class="icon-btn" onclick={briefPeriod} title="Ask Tern to brief you on this period"><Sparkles size={15} /></button>
      {/if}
      <button class="icon-btn" onclick={() => calendar.refresh()} title="Refresh"><RefreshCw size={14} /></button>
      <button class="btn primary" onclick={() => calendar.openComposer()}><Plus size={14} /> New <kbd>n</kbd></button>
    </div>
  </header>

  <div class="body">
    {#if railOpen}
      <aside class="rail">
        <MiniMonth />

        {#if calendar.calendars.length}
          <div class="rail-sec">
            <div class="eyebrow">Calendars</div>
            {#each calsByAccount as [accountId, cals] (accountId)}
              {#if app.accounts.length > 1 && !app.accountFilter}
                <div class="acct">{app.accountById.get(accountId)?.displayName || app.accountById.get(accountId)?.email}</div>
              {/if}
              {#each cals as c (c.id)}
                {@const off = calendar.hidden.has(c.id)}
                <button class="calrow" class:off onclick={() => calendar.toggleCalendar(c.id)} title={off ? "Show" : "Hide"}>
                  <span class="sw" style:background={calendar.colorOf({ calendarId: c.id, accountId: c.accountId })}>
                    {#if !off}<Check size={10} strokeWidth={3} />{/if}
                  </span>
                  <span class="cn">{c.name}</span>
                  {#if c.owner && !c.isDefault}<span class="own">{c.owner.split("@")[0]}</span>{/if}
                  <span class="eye">{#if off}<EyeOff size={12} />{:else}<Eye size={12} />{/if}</span>
                </button>
              {/each}
            {/each}
          </div>
        {/if}

        {#if upcomingInvites.length}
          <div class="rail-sec">
            <div class="eyebrow warn"><CalendarCheck size={11} /> {calendar.unanswered.length} to answer</div>
            {#each upcomingInvites as e (e.id)}
              <button class="inv" onclick={() => calendar.openDetails(e.id)}>
                <span class="it">{e.subject || "(no title)"}</span>
                <span class="iw mono">{whenLabel(e)}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if app.aiReady}
          <div class="rail-sec">
            <div class="eyebrow">Ask Tern</div>
            <button class="ai" onclick={() => ask("Find 30 min with ")}><Sparkles size={12} /> Find a time with…</button>
            <button class="ai" onclick={() => ask("What's my next meeting about? Check related mail.")}><Sparkles size={12} /> Prep my next meeting</button>
            <button class="ai" onclick={() => ask("Look at my week and suggest where I can protect 2 hours of focus time. Don't create anything yet.")}><Sparkles size={12} /> Protect focus time</button>
          </div>
        {/if}
      </aside>
    {/if}

    <div class="view">
      {#if calendar.view === "month"}
        <MonthGrid />
      {:else if calendar.view === "agenda"}
        <AgendaList />
      {:else}
        <TimeGrid />
      {/if}
    </div>
  </div>
</section>

<style>
  .cal {
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .toolbar {
    display: grid;
    grid-template-columns: auto minmax(200px, 1fr) auto;
    align-items: center;
    gap: 14px;
    padding: 10px 16px 10px 10px;
    border-bottom: 1px solid var(--line);
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .today.on {
    box-shadow: inset 0 0 0 1px var(--accent-line);
    color: var(--accent);
  }
  .arrows {
    display: flex;
  }
  h1 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 0 6px;
    font-size: 16.5px;
    font-weight: 680;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
    white-space: nowrap;
  }
  .wk {
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--hover);
  }
  .quick {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px 0 11px;
    border-radius: 999px;
    color: var(--muted);
    background: color-mix(in oklab, var(--bg-darker) 40%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    transition: box-shadow var(--t);
    min-width: 0;
  }
  .quick:focus-within {
    box-shadow: inset 0 0 0 1px var(--accent-line), 0 0 0 3px var(--accent-soft);
  }
  .quick.has {
    color: var(--accent);
  }
  .quick input {
    flex: 1;
    min-width: 0;
    background: transparent;
    font-size: 12.5px;
    color: var(--fg);
  }
  .quick input::placeholder {
    color: var(--muted);
  }
  .qp {
    font-size: 10.5px;
    color: var(--accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 320px;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .right kbd {
    margin-left: 4px;
  }
  .seg {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
    margin-right: 6px;
  }
  .seg button {
    height: 24px;
    padding: 0 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 550;
    color: var(--fg-dim);
    transition: all var(--t);
  }
  .seg button.on {
    color: var(--fg-bright);
    background: var(--raised);
    box-shadow: var(--shadow-sm);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
  }
  .rail-closed .body {
    grid-template-columns: minmax(0, 1fr);
  }
  .rail {
    border-right: 1px solid var(--line);
    overflow-y: auto;
    padding: 12px 10px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .rail-sec {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rail-sec .eyebrow {
    padding: 0 6px 6px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .eyebrow.warn {
    color: var(--red);
  }
  .acct {
    font-size: 11px;
    color: var(--muted);
    padding: 6px 6px 2px;
  }
  .calrow {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 6px;
    border-radius: 7px;
    font-size: 12.5px;
    color: var(--fg);
    text-align: left;
    transition: background var(--t);
  }
  .calrow:hover {
    background: var(--hover);
  }
  .calrow.off {
    color: var(--muted);
  }
  .sw {
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    color: white;
    flex: none;
  }
  .off .sw {
    background: transparent !important;
    box-shadow: inset 0 0 0 1.5px var(--line-strong);
  }
  .cn {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .own {
    font-size: 10px;
    color: var(--muted);
  }
  .eye {
    color: var(--muted);
    opacity: 0;
    display: grid;
  }
  .calrow:hover .eye {
    opacity: 1;
  }
  .inv {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border-radius: 8px;
    text-align: left;
    transition: background var(--t);
  }
  .inv:hover {
    background: var(--hover);
  }
  .it {
    font-size: 12.5px;
    font-weight: 550;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .iw {
    font-size: 10.5px;
    color: var(--muted);
  }
  .ai {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 8px;
    border-radius: 7px;
    font-size: 12px;
    color: var(--fg-dim);
    text-align: left;
    transition: all var(--t);
  }
  .ai:hover {
    color: var(--fg);
    background: var(--accent-soft);
  }
  .view {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  @media (max-width: 1250px) {
    .toolbar {
      grid-template-columns: auto 1fr auto;
    }
    .qp {
      display: none;
    }
  }
  @media (max-width: 1050px) {
    .quick {
      display: none;
    }
    .toolbar {
      grid-template-columns: 1fr auto;
    }
  }
</style>
