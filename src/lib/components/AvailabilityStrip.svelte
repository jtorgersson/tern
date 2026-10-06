<script lang="ts">
  // Scheduling assistant: free/busy of you and every invitee across the chosen day, with the proposed meeting
  // overlaid. Click a column to move the meeting there. Uses getSchedule (organisation accounts).
  import { api } from "$lib/api";
  import type { Addr, Availability } from "$lib/types";
  import { errMsg } from "$lib/util/misc";
  import { initialsOf } from "$lib/util/cal";
  import { LoaderCircle, Users } from "@lucide/svelte";

  let {
    accountId,
    me,
    people,
    date,
    start,
    end,
    workStart,
    workEnd,
    onpick,
  }: {
    accountId: string;
    me: Addr;
    people: Addr[];
    date: string;
    start: string; // "HH:MM"
    end: string;
    workStart: string;
    workEnd: string;
    onpick: (hhmm: string) => void;
  } = $props();

  const STEP = 30;
  const pad = (n: number) => String(n).padStart(2, "0");
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  // Show working hours with an hour of margin, widened to include the proposed meeting.
  const lo = $derived(Math.max(0, Math.min(toMin(workStart) - 60, Math.floor(toMin(start) / 60) * 60)));
  const hi = $derived(Math.min(1440, Math.max(toMin(workEnd) + 60, Math.ceil(toMin(end) / 60) * 60)));
  const slots = $derived(Array.from({ length: Math.max(1, Math.round((hi - lo) / STEP)) }, (_, i) => lo + i * STEP));

  let rows = $state<Availability[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const isMe = (p: Addr) => p.email.toLowerCase() === me.email.toLowerCase();
  const everyone = $derived([me, ...people.filter((p) => p.email.toLowerCase() !== me.email.toLowerCase())]);
  const key = $derived(`${accountId}|${date}|${everyone.map((p) => p.email.toLowerCase()).join(",")}`);

  $effect(() => {
    void key;
    clearTimeout(timer);
    if (!date || !people.length) return;
    timer = setTimeout(load, 350);
    return () => clearTimeout(timer);
  });

  async function load() {
    const s = ++seq;
    loading = true;
    error = null;
    try {
      const res = await api.availability(accountId, everyone.map((p) => p.email), `${date}T00:00:00`, `${date}T23:59:00`, STEP);
      if (s !== seq) return;
      rows = res;
      if (res.every((r) => !r.view)) error = "Availability isn't shared for these people.";
    } catch (e) {
      if (s !== seq) return;
      rows = [];
      const m = errMsg(e);
      error = /personal|not supported|MailboxNotEnabled|consumer/i.test(m) ? "Availability is only available for work or school accounts." : `Couldn't load availability: ${m}`;
    } finally {
      if (s === seq) loading = false;
    }
  }

  function stateAt(r: Availability | undefined, minute: number): string {
    if (!r?.view) return "?";
    return r.view[Math.floor(minute / STEP)] ?? "0";
  }
  const byEmail = $derived(new Map(rows.map((r) => [r.email.toLowerCase(), r])));
  const allFree = (m: number) => everyone.every((p) => stateAt(byEmail.get(p.email.toLowerCase()), m) === "0");
  const known = $derived(rows.some((r) => r.view));
  const sel = $derived({ from: toMin(start), to: toMin(end) });
  const overlay = $derived({
    left: ((Math.max(sel.from, lo) - lo) / (hi - lo)) * 100,
    width: ((Math.min(sel.to, hi) - Math.max(sel.from, lo)) / (hi - lo)) * 100,
  });
  const conflicts = $derived(
    known
      ? everyone.filter((p) => {
          const r = byEmail.get(p.email.toLowerCase());
          for (let m = sel.from; m < sel.to; m += STEP) if (["2", "3"].includes(stateAt(r, m))) return true;
          return false;
        })
      : [],
  );
  const label = (s: string) => (s === "1" ? "tentative" : s === "2" ? "busy" : s === "3" ? "away" : s === "4" ? "working elsewhere" : s === "0" ? "free" : "unknown");
</script>

{#if people.length}
  <div class="avail">
    <div class="head">
      <Users size={13} />
      <span class="t">Availability</span>
      {#if loading}<LoaderCircle size={12} class="spin" />{/if}
      <span class="spacer"></span>
      {#if known}
        {#if conflicts.length}
          <span class="warn">{conflicts.length} busy at this time</span>
        {:else}
          <span class="ok">Everyone is free</span>
        {/if}
      {/if}
    </div>
    {#if error && !known}
      <div class="msg">{error}</div>
    {:else}
      <div class="grid" style:--n={slots.length}>
        <div class="names">
          <span class="axis"></span>
          {#each everyone as p (p.email)}
            <span class="who" title={p.email}><span class="av">{initialsOf(p.name, p.email)}</span><span class="nm">{isMe(p) ? "You" : p.name || p.email}</span></span>
          {/each}
        </div>
        <div class="lanes">
          <div class="axis">
            {#each slots as m, i (m)}
              <span class="tick mono">{i % 2 === 0 ? `${pad(Math.floor(m / 60))}` : ""}</span>
            {/each}
          </div>
          {#each everyone as p (p.email)}
            {@const r = byEmail.get(p.email.toLowerCase())}
            <div class="lane">
              {#each slots as m (m)}
                {@const st = stateAt(r, m)}
                <button
                  class="slot s{st}"
                  class:allfree={allFree(m)}
                  title="{isMe(p) ? 'You' : p.name || p.email}: {pad(Math.floor(m / 60))}:{pad(m % 60)} {label(st)}"
                  onclick={() => onpick(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)}
                  aria-label="{pad(Math.floor(m / 60))}:{pad(m % 60)} {label(st)}"></button>
              {/each}
            </div>
          {/each}
          {#if overlay.width > 0}
            <div class="sel" class:bad={conflicts.length > 0} style:left="{overlay.left}%" style:width="{overlay.width}%"></div>
          {/if}
        </div>
      </div>
      <div class="legend">
        <span><i class="k s0"></i>free</span>
        <span><i class="k s1"></i>tentative</span>
        <span><i class="k s2"></i>busy</span>
        <span><i class="k s3"></i>away</span>
        <span class="hintc">Click a time to move the meeting there</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .avail {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--bg-darker) 30%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    animation: fade-up 180ms var(--ease);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--fg-dim);
  }
  .t {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .spacer {
    flex: 1;
  }
  .ok {
    font-size: 11.5px;
    color: var(--green);
  }
  .warn {
    font-size: 11.5px;
    color: var(--red);
  }
  .msg {
    font-size: 12px;
    color: var(--muted);
  }
  .grid {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0 8px;
  }
  .names,
  .lanes {
    display: grid;
    grid-auto-rows: 20px;
    row-gap: 3px;
  }
  .names .axis,
  .lanes .axis {
    height: 14px;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .av {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    font-size: 8px;
    font-weight: 700;
    background: color-mix(in oklab, var(--accent) 22%, transparent);
    color: var(--fg);
  }
  .nm {
    font-size: 11.5px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lanes {
    position: relative;
  }
  .lanes .axis {
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
  }
  .tick {
    font-size: 9px;
    color: var(--muted);
  }
  .lane {
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
    gap: 1px;
  }
  .slot {
    height: 100%;
    border-radius: 2px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    cursor: pointer;
  }
  .slot:hover {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .slot.allfree {
    background: color-mix(in oklab, var(--green) 14%, transparent);
  }
  .s1 {
    background: repeating-linear-gradient(135deg, color-mix(in oklab, var(--fg) 30%, transparent) 0 3px, transparent 3px 6px) !important;
  }
  .s2,
  .s4 {
    background: color-mix(in oklab, var(--fg) 38%, transparent) !important;
  }
  .s3 {
    background: color-mix(in oklab, var(--magenta) 55%, transparent) !important;
  }
  .s\? {
    background: transparent !important;
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .sel {
    position: absolute;
    top: 14px;
    bottom: 0;
    border-radius: 4px;
    box-shadow: inset 0 0 0 2px var(--accent);
    background: color-mix(in oklab, var(--accent) 12%, transparent);
    pointer-events: none;
    transition: left 160ms var(--ease), width 160ms var(--ease);
  }
  .sel.bad {
    box-shadow: inset 0 0 0 2px var(--red);
    background: color-mix(in oklab, var(--red) 10%, transparent);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    font-size: 10.5px;
    color: var(--muted);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .k {
    display: inline-block;
    width: 12px;
    height: 10px;
    border-radius: 2px;
  }
  .k.s0 {
    background: color-mix(in oklab, var(--green) 14%, transparent);
  }
  .hintc {
    margin-left: auto;
  }
</style>
