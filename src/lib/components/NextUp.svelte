<script lang="ts">
  // "Next up" pill in the top bar: the next meeting with a live countdown and a Join button, wherever you are.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { isNow, untilLabel, hm } from "$lib/util/cal";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { Video, CalendarClock } from "@lucide/svelte";

  const ev = $derived(calendar.nextUp);
  const live = $derived(ev ? isNow(ev, calendar.now) : false);
  const minsTo = $derived(ev ? Math.round((new Date(ev.start).getTime() - calendar.now.getTime()) / 60_000) : 0);
  const soon = $derived(!!ev && !live && minsTo <= 15);
  const label = $derived.by(() => {
    if (!ev) return "";
    if (live) return `until ${hm(ev.end)}`;
    return untilLabel(ev, calendar.now);
  });

  function open() {
    if (!ev) return;
    app.setView({ kind: "calendar" });
    calendar.goto(new Date(ev.start));
    calendar.openDetails(ev.id);
  }
</script>

{#if ev}
  <div class="next" class:live class:soon title="{ev.subject} · {hm(ev.start)}–{hm(ev.end)}">
    <button class="main" onclick={open}>
      <span class="ic"><CalendarClock size={13} /></span>
      <span class="txt">
        <span class="s">{ev.subject || "(no title)"}</span>
        <span class="w mono">{hm(ev.start)} · {label}</span>
      </span>
    </button>
    {#if ev.joinUrl && (live || soon)}
      <button class="join" onclick={() => openUrl(ev.joinUrl!)} title="Join Teams meeting"><Video size={13} /> Join</button>
    {/if}
  </div>
{/if}

<style>
  .next {
    display: inline-flex;
    align-items: center;
    height: 30px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    overflow: hidden;
    max-width: 300px;
    transition: box-shadow var(--t), background var(--t);
  }
  .next.soon {
    box-shadow: inset 0 0 0 1px var(--accent-line);
    background: var(--accent-soft);
  }
  .next.live {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--green) 45%, transparent);
    background: color-mix(in oklab, var(--green) 12%, transparent);
  }
  .main {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 100%;
    padding: 0 10px 0 9px;
    min-width: 0;
  }
  .main:hover {
    background: var(--hover);
  }
  .ic {
    display: grid;
    color: var(--fg-dim);
  }
  .soon .ic {
    color: var(--accent);
  }
  .live .ic {
    color: var(--green);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }
  .txt {
    display: flex;
    flex-direction: column;
    line-height: 1.1;
    min-width: 0;
    text-align: left;
  }
  .s {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--fg-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
  .w {
    font-size: 9.5px;
    color: var(--muted);
    white-space: nowrap;
  }
  .soon .w {
    color: var(--accent);
  }
  .live .w {
    color: var(--green);
  }
  .join {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 100%;
    padding: 0 11px;
    font-size: 11.5px;
    font-weight: 650;
    color: var(--on-accent);
    background: var(--accent);
  }
  .live .join {
    background: var(--green);
  }
  .join:hover {
    filter: brightness(1.08);
  }
  @media (max-width: 1000px) {
    .next {
      display: none;
    }
  }
</style>
