<script lang="ts">
  // Event details popover: attendees with responses, organizer, location, join link, respond buttons.
  import { calendar } from "$lib/state/calendar.svelte";
  import { app } from "$lib/state/app.svelte";
  import { agent } from "$lib/state/agent.svelte";
  import type { InviteAction } from "$lib/types";
  import { whenLabel, untilLabel, isPast, initialsOf, RESPONSE_LABEL } from "$lib/util/cal";
  import { hueColor } from "$lib/theme";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { X, Video, MapPin, ExternalLink, Check, CircleHelp, Ban, Crown, CircleAlert, Sparkles, AlertTriangle } from "@lucide/svelte";

  const ev = $derived(calendar.details);
  const acct = $derived(ev ? app.accountById.get(ev.accountId) : undefined);
  const conflicts = $derived(ev ? calendar.conflictsFor(ev) : []);
  const past = $derived(ev ? isPast(ev, calendar.now) : false);
  const canRespond = $derived(!!ev && ev.response !== "organizer" && !ev.isCancelled && !past && ev.organizer != null);
  let busy = $state<InviteAction | null>(null);
  let note = $state("");
  let showNote = $state(false);
  let sendResponse = $state(true);

  $effect(() => {
    void ev?.id;
    note = "";
    showNote = false;
    sendResponse = true;
  });

  async function respond(action: InviteAction) {
    if (!ev) return;
    busy = action;
    try {
      await calendar.respond(ev, action, note.trim() || null, sendResponse);
    } catch {
      /* toast */
    } finally {
      busy = null;
    }
  }

  const counts = $derived.by(() => {
    const c = { accepted: 0, tentativelyAccepted: 0, declined: 0, notResponded: 0 };
    for (const a of ev?.attendees ?? []) if (a.response in c) c[a.response as keyof typeof c]++;
    return c;
  });

  function ask() {
    if (!ev) return;
    app.toggleAgent(true);
    agent.send(`What is my meeting "${ev.subject}" (${whenLabel(ev)}) about? Check related mail.`);
  }
</script>

{#if ev}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => calendar.openDetails(null)}>
    <div class="pop" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Event details" tabindex="-1">
      <header>
        <div class="when">
          <span class="eyebrow">{whenLabel(ev)}</span>
          {#if !past && !ev.isCancelled}<span class="until mono">{untilLabel(ev, calendar.now)}</span>{/if}
        </div>
        <button class="icon-btn s" onclick={() => calendar.openDetails(null)} aria-label="Close"><X size={15} /></button>
      </header>
      <h2 class:strike={ev.isCancelled || ev.response === "declined"}>{ev.subject || "(no title)"}</h2>
      <div class="badges">
        {#if ev.isCancelled}<span class="pill warn">Cancelled</span>{/if}
        {#if ev.response === "organizer"}<span class="pill acc"><Crown size={11} /> You organize</span>
        {:else if ev.response === "accepted"}<span class="pill ok"><Check size={11} /> Accepted</span>
        {:else if ev.response === "tentativelyAccepted"}<span class="pill maybe"><CircleHelp size={11} /> Tentative</span>
        {:else if ev.response === "declined"}<span class="pill"><Ban size={11} /> Declined</span>
        {:else if ev.response === "notResponded"}<span class="pill warn"><CircleAlert size={11} /> Not responded</span>{/if}
        {#if acct && app.accounts.length > 1}<span class="pill acct"><span class="dot" style:background={hueColor(acct.hue, app.mode)}></span>{acct.email}</span>{/if}
      </div>

      {#if conflicts.length && !ev.isCancelled && ev.response !== "declined"}
        <div class="conflict">
          <AlertTriangle size={13} />
          <div>
            {#each conflicts as c (c.id)}
              <div>Overlaps with <b>{c.subject || "(no title)"}</b> <span class="mono">{whenLabel(c).split(", ")[1] ?? ""}</span></div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="rows">
        {#if ev.isOnline && ev.joinUrl}
          <button class="btn primary join" onclick={() => openUrl(ev.joinUrl!)} disabled={past || ev.isCancelled}><Video size={14} /> Join Teams meeting</button>
        {/if}
        {#if ev.location}
          <div class="row"><MapPin size={14} /><span>{ev.location}</span></div>
        {/if}
        {#if ev.organizer}
          <div class="row"><Crown size={14} /><span>Organized by <b>{ev.organizer.name || ev.organizer.email}</b></span></div>
        {/if}
      </div>

      {#if ev.attendees.length}
        <div class="att-head">
          <span class="eyebrow">{ev.attendees.length} attendee{ev.attendees.length === 1 ? "" : "s"}</span>
          <span class="tally mono">
            {#if counts.accepted}<span class="ok">{counts.accepted} ✓</span>{/if}
            {#if counts.tentativelyAccepted}<span class="maybe">{counts.tentativelyAccepted} ?</span>{/if}
            {#if counts.declined}<span class="no">{counts.declined} ✕</span>{/if}
            {#if counts.notResponded}<span class="muted">{counts.notResponded} –</span>{/if}
          </span>
        </div>
        <ul class="attendees">
          {#each ev.attendees as a (a.addr.email)}
            <li>
              <span class="av" class:optional={a.type === "optional"}>{initialsOf(a.addr.name, a.addr.email)}</span>
              <span class="an">{a.addr.name || a.addr.email}</span>
              {#if a.type === "optional"}<span class="opt">optional</span>{/if}
              <span class="spacer"></span>
              <span class="resp {a.response}" title={RESPONSE_LABEL[a.response]}>
                {#if a.response === "accepted"}<Check size={12} strokeWidth={2.6} />{:else if a.response === "tentativelyAccepted"}<CircleHelp size={12} />{:else if a.response === "declined"}<Ban size={12} />{:else if a.response === "organizer"}<Crown size={11} />{:else}<span class="dash">–</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if ev.preview}
        <p class="preview">{ev.preview}</p>
      {/if}

      {#if canRespond}
        <div class="respond">
          <div class="rbtns">
            <button class="btn" class:on={ev.response === "accepted"} disabled={!!busy} onclick={() => respond("accept")}><Check size={13} /> Accept</button>
            <button class="btn" class:on={ev.response === "tentativelyAccepted"} disabled={!!busy} onclick={() => respond("tentativelyAccept")}><CircleHelp size={13} /> Tentative</button>
            <button class="btn" class:on={ev.response === "declined"} disabled={!!busy} onclick={() => respond("decline")}><Ban size={13} /> Decline</button>
            <span class="spacer"></span>
            {#if !showNote}<button class="link" onclick={() => (showNote = true)}>Add a note</button>{/if}
          </div>
          {#if showNote}
            <input class="field" bind:value={note} placeholder="Note to the organizer (optional)" />
          {/if}
          <label class="send"><input type="checkbox" checked={!sendResponse} onchange={(e) => (sendResponse = !(e.currentTarget as HTMLInputElement).checked)} /> Don't send a response</label>
        </div>
      {/if}

      <footer>
        {#if app.aiReady}<button class="mini" onclick={ask}><Sparkles size={12} /> What's this about?</button>{/if}
        <span class="spacer"></span>
        {#if ev.webLink}<button class="mini" onclick={() => openUrl(ev.webLink!)}>Open in Outlook <ExternalLink size={12} /></button>{/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 48;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--bg-darker) 45%, transparent);
    animation: fade 140ms;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .pop {
    width: min(520px, calc(100vw - 40px));
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    padding: 16px 18px 14px;
    border-radius: 16px;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: var(--shadow);
    animation: fade-up 180ms var(--ease);
    display: flex;
    flex-direction: column;
    gap: 12px;
    user-select: text;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .when {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .until {
    font-size: 10.5px;
    color: var(--accent);
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
  }
  h2 {
    margin: -4px 0 0;
    font-size: 19px;
    font-weight: 680;
    letter-spacing: -0.02em;
    line-height: 1.25;
    color: var(--fg-bright);
  }
  h2.strike {
    text-decoration: line-through;
    color: var(--muted);
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: -4px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 11px;
    color: var(--fg-dim);
    background: var(--hover);
  }
  .pill.ok {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 16%, transparent);
  }
  .pill.maybe {
    color: var(--yellow);
    background: color-mix(in oklab, var(--yellow) 16%, transparent);
  }
  .pill.warn {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 14%, transparent);
  }
  .pill.acc {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .pill.acct .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
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
  .rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 13px;
    color: var(--fg-dim);
  }
  .row b {
    color: var(--fg);
    font-weight: 600;
  }
  .join {
    align-self: flex-start;
  }
  .att-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: -6px;
  }
  .tally {
    display: flex;
    gap: 8px;
    font-size: 10.5px;
  }
  .tally .ok {
    color: var(--green);
  }
  .tally .maybe {
    color: var(--yellow);
  }
  .tally .no {
    color: var(--red);
  }
  .tally .muted {
    color: var(--muted);
  }
  .attendees {
    list-style: none;
    margin: 0;
    padding: 4px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    max-height: 220px;
    overflow-y: auto;
  }
  .attendees li {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 8px;
    border-radius: 8px;
    font-size: 12.5px;
  }
  .attendees li:hover {
    background: var(--hover);
  }
  .av {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    font-size: 9.5px;
    font-weight: 650;
    color: var(--fg);
    background: color-mix(in oklab, var(--accent) 22%, transparent);
  }
  .av.optional {
    opacity: 0.7;
  }
  .an {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opt {
    font-size: 10px;
    color: var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .resp {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: var(--muted);
  }
  .resp.accepted {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 16%, transparent);
  }
  .resp.tentativelyAccepted {
    color: var(--yellow);
  }
  .resp.declined {
    color: var(--red);
  }
  .resp.organizer {
    color: var(--accent);
  }
  .dash {
    font-size: 11px;
  }
  .preview {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--fg-dim);
    white-space: pre-wrap;
    max-height: 120px;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, black 70%, transparent);
  }
  .respond {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--line);
  }
  .rbtns {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .rbtns .btn.on {
    box-shadow: inset 0 0 0 1px var(--accent-line);
    background: var(--accent-soft);
  }
  .link {
    font-size: 12px;
    color: var(--accent);
  }
  .send {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--muted);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 -8px -4px;
  }
  .mini {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--fg-dim);
    padding: 4px 8px;
    border-radius: 6px;
  }
  .mini:hover {
    color: var(--fg);
    background: var(--hover);
  }
</style>
