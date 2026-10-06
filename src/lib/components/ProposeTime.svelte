<script lang="ts">
  // Counter-propose a time for an invitation: pick a free slot (or type one) and send it with a tentative
  // or declined response. Graph delivers the proposal to the organizer as a real "new time proposed".
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { api } from "$lib/api";
  import type { CalEvent, FreeSlot } from "$lib/types";
  import { addDays, dayKey, dayLabel, hm, minutesBetween, startOfDay, toLocalIso } from "$lib/util/cal";
  import { dayMonth } from "$lib/util/fmt";
  import { toasts } from "$lib/state/toasts.svelte";
  import { errMsg } from "$lib/util/misc";
  import { LoaderCircle, Send, X, Sparkles } from "@lucide/svelte";
  import { untrack } from "svelte";

  let { ev, onclose }: { ev: CalEvent; onclose: () => void } = $props();

  const dur = $derived(Math.max(15, minutesBetween(ev.start, ev.end)));
  let slots = $state<FreeSlot[]>([]);
  let finding = $state(true);
  let date = $state("");
  let time = $state("");
  let note = $state("");
  let action = $state<"tentativelyAccept" | "decline">("tentativelyAccept");
  let sending = $state(false);
  const pad = (n: number) => String(n).padStart(2, "0");

  $effect(() => {
    const e = ev;
    untrack(() => {
      date = dayKey(new Date(e.start));
      time = hm(e.start);
      find();
    });
  });

  async function find() {
    finding = true;
    try {
      const from = toLocalIso(new Date(Math.max(Date.now(), startOfDay().getTime())));
      const to = toLocalIso(addDays(startOfDay(), 10));
      const others = [...(ev.organizer ? [ev.organizer.email] : []), ...ev.attendees.map((a) => a.addr.email)];
      const res = await api.freeSlots({ accountId: ev.accountId, attendees: others, from, to, durationMins: dur, workStart: app.settings?.calendar.workStart, workEnd: app.settings?.calendar.workEnd });
      slots = res.filter((s) => s.start !== ev.start).slice(0, 6);
      if (slots[0]) use(slots[0]);
    } catch {
      slots = [];
    } finally {
      finding = false;
    }
  }
  function use(s: FreeSlot) {
    date = dayKey(s.start);
    time = hm(s.start);
  }
  const start = $derived(`${date}T${time}:00`);
  const end = $derived.by(() => {
    const d = new Date(start);
    const e = new Date(d.getTime() + dur * 60_000);
    return `${dayKey(e)}T${pad(e.getHours())}:${pad(e.getMinutes())}:00`;
  });
  const selected = $derived(slots.find((s) => s.start === start));

  async function send() {
    if (!date || !time) return;
    sending = true;
    try {
      await calendar.respond(ev, action, note.trim() || null, true, { start, end });
      onclose();
    } catch (e) {
      toasts.error(errMsg(e));
    } finally {
      sending = false;
    }
  }
</script>

<div class="propose">
  <div class="head">
    <span class="eyebrow"><Sparkles size={11} /> Propose a new time</span>
    <button class="icon-btn s" onclick={onclose} aria-label="Close"><X size={13} /></button>
  </div>
  <div class="slots">
    {#if finding}
      <span class="muted"><LoaderCircle size={12} class="spin" /> Checking when everyone is free…</span>
    {:else if slots.length}
      {#each slots as s (s.start)}
        <button class="slot" class:on={selected?.start === s.start} onclick={() => use(s)}>{dayLabel(new Date(s.start), calendar.now).slice(0, 3)} {dayMonth(s.start)} · {hm(s.start)}</button>
      {/each}
    {:else}
      <span class="muted">No common free slot found in the next 10 days — pick a time:</span>
    {/if}
  </div>
  <div class="row">
    <input type="date" class="field" bind:value={date} />
    <input type="time" class="field" bind:value={time} step="300" />
    <span class="muted mono">{dur} min</span>
    <select bind:value={action}>
      <option value="tentativelyAccept">Reply tentative</option>
      <option value="decline">Reply decline</option>
    </select>
  </div>
  <input class="field" bind:value={note} placeholder="Message to the organizer (optional)" />
  <div class="row">
    <button class="btn sm primary" onclick={send} disabled={sending || !date || !time}>{#if sending}<LoaderCircle size={12} class="spin" />{:else}<Send size={12} />{/if} Send proposal</button>
    <span class="muted">Sent to {ev.organizer?.name || ev.organizer?.email || "the organizer"}</span>
  </div>
</div>

<style>
  .propose {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--accent) 7%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 20%, var(--line));
    animation: fade-up 180ms var(--ease);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
  }
  .slots {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .slot {
    height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-family: var(--font-mono);
    color: var(--fg);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: all var(--t);
  }
  .slot:hover {
    background: var(--accent-soft);
  }
  .slot.on {
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .row .field {
    width: auto;
    height: 30px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .row select {
    font-size: 12px;
    color: var(--fg);
    background: transparent;
  }
  .muted {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .field {
    height: 30px;
    font-size: 12.5px;
  }
</style>
