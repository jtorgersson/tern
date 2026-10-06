<script lang="ts">
  // Invitation card at the top of the reader for meeting-request / response messages.
  import { calendar } from "$lib/state/calendar.svelte";
  import { app } from "$lib/state/app.svelte";
  import { agent } from "$lib/state/agent.svelte";
  import type { InviteAction, MessageFull } from "$lib/types";
  import { whenLabel, untilLabel, isPast, initialsOf, hm } from "$lib/util/cal";
  import { displayName } from "$lib/util/misc";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { CalendarDays, Video, MapPin, Check, CircleHelp, Ban, AlertTriangle, LoaderCircle, Sparkles, Crown } from "@lucide/svelte";

  let { message }: { message: MessageFull } = $props();

  $effect(() => {
    calendar.invite(message.id);
  });

  const info = $derived(calendar.invites[message.id]);
  const loading = $derived(calendar.inviteLoading.has(message.id));
  const ev = $derived(info?.event ?? null);
  const type = $derived(info?.meetingType ?? message.meetingType ?? "none");
  const past = $derived(ev ? isPast(ev, calendar.now) : false);
  const canRespond = $derived(!!ev && type === "meetingRequest" && !ev.isCancelled && !past && ev.response !== "organizer");
  let busy = $state<InviteAction | null>(null);
  let note = $state("");
  let showNote = $state(false);
  let sendResponse = $state(true);

  async function respond(action: InviteAction) {
    if (!ev) return;
    busy = action;
    try {
      await calendar.respond(ev, action, note.trim() || null, sendResponse);
      showNote = false;
      note = "";
    } catch {
      /* toast */
    } finally {
      busy = null;
    }
  }

  const responseLine = $derived.by(() => {
    const who = displayName(message.from);
    switch (type) {
      case "meetingAccepted": return `${who} accepted`;
      case "meetingTentativelyAccepted": return `${who} tentatively accepted`;
      case "meetingDeclined": return `${who} declined`;
      case "meetingCancelled": return "This meeting was cancelled";
      default: return "";
    }
  });

  function proposeNewTime() {
    if (!ev) return;
    app.toggleAgent(true);
    agent.send(`Propose 2–3 alternative times for "${ev.subject}" (currently ${whenLabel(ev)}) with ${ev.organizer?.name || ev.organizer?.email || "the organizer"}, then draft a reply to this invitation suggesting them.`);
  }
</script>

<div class="invite" class:cancelled={type === "meetingCancelled" || ev?.isCancelled}>
  <div class="head">
    <span class="ic"><CalendarDays size={13} /></span>
    <span class="eyebrow">{type === "meetingRequest" ? "Invitation" : type === "meetingCancelled" ? "Cancellation" : "Meeting response"}</span>
    <span class="spacer"></span>
    {#if loading && !info}<LoaderCircle size={13} class="spin" />{/if}
    {#if ev && !past && !ev.isCancelled}<span class="until mono">{untilLabel(ev, calendar.now)}</span>{/if}
  </div>

  {#if responseLine}
    <div class="resp-line">
      {#if type === "meetingAccepted"}<Check size={14} class="ok" />{:else if type === "meetingDeclined"}<Ban size={14} class="no" />{:else if type === "meetingTentativelyAccepted"}<CircleHelp size={14} class="maybe" />{:else}<AlertTriangle size={14} class="no" />{/if}
      <b>{responseLine}</b>
    </div>
  {/if}

  {#if ev}
    <div class="when">
      <div class="big">{whenLabel(ev)}</div>
      <div class="sub">
        {#if ev.isOnline}<span class="meta teams"><Video size={12} /> Teams meeting</span>{/if}
        {#if ev.location}<span class="meta"><MapPin size={12} /> {ev.location}</span>{/if}
        {#if ev.organizer}<span class="meta"><Crown size={12} /> {ev.organizer.name || ev.organizer.email}</span>{/if}
      </div>
    </div>

    {#if ev.attendees.length}
      <div class="people">
        {#each ev.attendees.slice(0, 7) as a (a.addr.email)}
          <span class="av {a.response}" title="{a.addr.name || a.addr.email} · {a.response}">{initialsOf(a.addr.name, a.addr.email)}</span>
        {/each}
        {#if ev.attendees.length > 7}<span class="more">+{ev.attendees.length - 7}</span>{/if}
        <span class="count">{ev.attendees.length} attendee{ev.attendees.length === 1 ? "" : "s"}</span>
      </div>
    {/if}

    {#if info?.conflicts.length && canRespond}
      <div class="conflict">
        <AlertTriangle size={13} />
        <div>
          {#each info.conflicts as c (c.id)}
            <div>Overlaps with <b>{c.subject || "(no title)"}</b> <span class="mono">{hm(c.start)}–{hm(c.end)}</span></div>
          {/each}
        </div>
      </div>
    {/if}

    {#if canRespond}
      <div class="respond">
        <div class="rbtns">
          <button class="btn sm yes" class:on={ev.response === "accepted"} disabled={!!busy} onclick={() => respond("accept")}>
            {#if busy === "accept"}<LoaderCircle size={12} class="spin" />{:else}<Check size={13} />{/if} Accept
          </button>
          <button class="btn sm" class:on={ev.response === "tentativelyAccepted"} disabled={!!busy} onclick={() => respond("tentativelyAccept")}><CircleHelp size={13} /> Tentative</button>
          <button class="btn sm" class:on={ev.response === "declined"} disabled={!!busy} onclick={() => respond("decline")}><Ban size={13} /> Decline</button>
          <span class="spacer"></span>
          {#if ev.response !== "notResponded"}
            <span class="state">{ev.response === "accepted" ? "You accepted" : ev.response === "declined" ? "You declined" : "You're tentative"}</span>
          {/if}
          {#if !showNote}<button class="link" onclick={() => (showNote = true)}>Add a note</button>{/if}
        </div>
        {#if showNote}<input class="field" bind:value={note} placeholder="Note to the organizer (optional)" />{/if}
        <div class="foot">
          <label class="send"><input type="checkbox" checked={!sendResponse} onchange={(e) => (sendResponse = !(e.currentTarget as HTMLInputElement).checked)} /> Don't send a response</label>
          <span class="spacer"></span>
          {#if ev.joinUrl}<button class="link" onclick={() => openUrl(ev.joinUrl!)}><Video size={12} /> Join</button>{/if}
          {#if app.aiReady}<button class="link" onclick={proposeNewTime}><Sparkles size={12} /> Propose a new time</button>{/if}
        </div>
      </div>
    {:else if ev.response === "organizer"}
      <div class="state">You organized this meeting.</div>
    {/if}
  {:else if info && !ev}
    <div class="gone">The meeting is no longer on your calendar.</div>
  {/if}
</div>

<style>
  .invite {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    margin-bottom: 14px;
    border-radius: 14px;
    background:
      linear-gradient(135deg, color-mix(in oklab, var(--blue) 12%, transparent), transparent 60%),
      color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--blue) 25%, var(--line));
    animation: fade-up 200ms var(--ease);
  }
  .invite.cancelled {
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ic {
    display: grid;
    color: var(--blue);
  }
  .eyebrow {
    color: var(--blue);
  }
  .spacer {
    flex: 1;
  }
  .until {
    font-size: 10.5px;
    color: var(--accent);
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
  }
  .resp-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
  }
  .resp-line b {
    font-weight: 600;
  }
  .resp-line :global(.ok) {
    color: var(--green);
  }
  .resp-line :global(.no) {
    color: var(--red);
  }
  .resp-line :global(.maybe) {
    color: var(--yellow);
  }
  .when .big {
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.015em;
    color: var(--fg-bright);
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 4px;
    font-size: 12.5px;
    color: var(--fg-dim);
  }
  .meta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .meta.teams {
    color: color-mix(in oklab, var(--blue) 80%, var(--fg));
  }
  .people {
    display: flex;
    align-items: center;
    gap: 0;
  }
  .av {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    margin-right: -6px;
    border-radius: 50%;
    font-size: 9.5px;
    font-weight: 650;
    color: var(--fg);
    background: color-mix(in oklab, var(--accent) 24%, var(--bg));
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--bg-lighter) 60%, var(--bg));
  }
  .av.accepted {
    box-shadow: 0 0 0 2px var(--green);
  }
  .av.declined {
    opacity: 0.45;
  }
  .more {
    margin-left: 12px;
    font-size: 11px;
    color: var(--muted);
    font-family: var(--font-mono);
  }
  .count {
    margin-left: 14px;
    font-size: 12px;
    color: var(--muted);
  }
  .conflict {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 10px;
    border-radius: 10px;
    font-size: 12.5px;
    color: var(--red);
    background: color-mix(in oklab, var(--red) 10%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--red) 30%, transparent);
  }
  .conflict b {
    color: var(--fg-bright);
    font-weight: 600;
  }
  .conflict .mono {
    font-size: 11px;
    opacity: 0.85;
  }
  .respond {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
  .rbtns {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .btn.yes {
    color: var(--green);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--green) 40%, transparent);
  }
  .btn.yes:hover {
    background: color-mix(in oklab, var(--green) 14%, transparent);
  }
  .btn.on {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .state {
    font-size: 12px;
    color: var(--fg-dim);
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 550;
    color: var(--accent);
    padding: 2px 6px;
    border-radius: 6px;
  }
  .link:hover {
    background: var(--hover);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .send {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--muted);
  }
  .gone {
    font-size: 12.5px;
    color: var(--muted);
  }
</style>
