<script lang="ts">
  // Snooze picker (z): presets computed from now, or a custom date and time. Number keys pick a preset.
  import { app } from "$lib/state/app.svelte";
  import { addDays, dayKey, startOfDay } from "$lib/util/cal";
  import { hhmm, weekdayDayMonth, weekdayShort } from "$lib/util/fmt";
  import { AlarmClock, X } from "@lucide/svelte";
  import { tick } from "svelte";

  const ids = $derived(app.snoozeTarget);
  let custom = $state("");
  let el: HTMLDivElement | undefined = $state();

  interface Preset {
    label: string;
    at: Date;
  }
  const at = (d: Date, h: number, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);

  const presets = $derived.by<Preset[]>(() => {
    if (!ids) return [];
    const now = new Date();
    const today = startOfDay(now);
    const out: Preset[] = [];
    const later = new Date(now.getTime() + 3 * 3_600_000);
    later.setMinutes(0, 0, 0);
    if (later.getHours() < 21 && dayKey(later) === dayKey(now)) out.push({ label: "Later today", at: later });
    if (now.getHours() < 17) out.push({ label: "This evening", at: at(today, 18) });
    out.push({ label: "Tomorrow morning", at: at(addDays(today, 1), 8) });
    const dow = now.getDay(); // 0 Sun … 6 Sat
    if (dow >= 1 && dow <= 4) out.push({ label: "This weekend", at: at(addDays(today, 6 - dow), 9) });
    out.push({ label: "Next week", at: at(addDays(today, ((8 - dow) % 7) || 7), 8) });
    out.push({ label: "In a month", at: at(addDays(today, 30), 8) });
    return out;
  });

  $effect(() => {
    if (ids) {
      const d = addDays(startOfDay(), 1);
      custom = `${dayKey(d)}T08:00`;
      tick().then(() => el?.focus());
    }
  });

  function pick(d: Date) {
    if (!ids) return;
    if (d.getTime() <= Date.now() + 60_000) return;
    app.snoozeTarget = null;
    app.snooze(ids, d);
  }
  function close() {
    app.snoozeTarget = null;
  }
  function onkey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) {
      if (e.key === "Enter") {
        e.preventDefault();
        pick(new Date(custom));
      } else if (e.key === "Escape") close();
      e.stopPropagation();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= presets.length) {
      e.preventDefault();
      pick(presets[n - 1].at);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  }
  const customValid = $derived(!!custom && new Date(custom).getTime() > Date.now() + 60_000);
</script>

{#if ids}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close}>
    <div class="pop" bind:this={el} tabindex="-1" role="dialog" aria-label="Snooze" onclick={(e) => e.stopPropagation()} onkeydown={onkey}>
      <header>
        <AlarmClock size={15} />
        <span class="t">Snooze {ids.length > 1 ? `${ids.length} messages` : ""}</span>
        <span class="spacer"></span>
        <button class="icon-btn s" onclick={close} aria-label="Close"><X size={14} /></button>
      </header>
      <div class="list">
        {#each presets as p, i (p.label)}
          <button class="opt" onclick={() => pick(p.at)}>
            <kbd>{i + 1}</kbd>
            <span class="l">{p.label}</span>
            <span class="w mono">{dayKey(p.at) === dayKey(new Date()) ? "" : `${weekdayShort(p.at)} `}{hhmm(p.at)}</span>
          </button>
        {/each}
      </div>
      <div class="custom">
        <input type="datetime-local" class="field" bind:value={custom} step="900" />
        <button class="btn sm primary" disabled={!customValid} onclick={() => pick(new Date(custom))}>Snooze</button>
      </div>
      {#if customValid}<div class="hint">Until {weekdayDayMonth(new Date(custom))} {hhmm(new Date(custom))}. It comes back unread with a notification.</div>{/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--bg-darker) 40%, transparent);
    animation: fade 120ms;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .pop {
    width: min(380px, calc(100vw - 40px));
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px 14px;
    border-radius: 16px;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: var(--shadow);
    animation: fade-up 160ms var(--ease);
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
  }
  .t {
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .spacer {
    flex: 1;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border-radius: 9px;
    text-align: left;
    transition: background var(--t);
  }
  .opt:hover,
  .opt:focus-visible {
    background: var(--accent-soft);
    outline: none;
  }
  .l {
    flex: 1;
    font-size: 13px;
    color: var(--fg);
  }
  .w {
    font-size: 11.5px;
    color: var(--muted);
  }
  .custom {
    display: flex;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--line);
  }
  .custom .field {
    flex: 1;
    height: 30px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .hint {
    font-size: 11.5px;
    color: var(--muted);
  }
</style>
