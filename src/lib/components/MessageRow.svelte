<script lang="ts">
  import type { MessageSummary } from "$lib/types";
  import { app, CATEGORY_META } from "$lib/state/app.svelte";
  import { hueColor } from "$lib/theme";
  import { shortTime, longTime } from "$lib/util/time";
  import { displayName } from "$lib/util/misc";
  import Avatar from "./Avatar.svelte";
  import { AlarmClock, Paperclip, Star, Archive, Trash2, Mail, MailOpen, Sparkles, Check, CalendarDays } from "@lucide/svelte";

  let {
    m,
    selected,
    checked,
    showAccount,
    compact,
  }: { m: MessageSummary; selected: boolean; checked: boolean; showAccount: boolean; compact: boolean } = $props();

  const acct = $derived(app.accountById.get(m.accountId));
  const isSentView = $derived(app.view.kind === "unified" && (app.view.wellKnown === "sentitems" || app.view.wellKnown === "drafts"));
  const who = $derived(isSentView ? (m.to[0] ?? m.from) : m.from);
  const cat = $derived(m.ai ? CATEGORY_META[m.ai.category] : null);
  const showCat = $derived(m.ai && app.view.kind !== "category" && m.ai.category !== "fyi");

  function stop(e: Event, fn: () => void) {
    e.stopPropagation();
    fn();
  }
</script>

<div
  class="row"
  class:selected
  class:unread={!m.isRead}
  class:checked
  class:compact
  role="option"
  aria-selected={selected}
  tabindex="-1"
  data-id={m.id}
  onclick={(e) => (e.ctrlKey || e.metaKey ? app.toggleCheck(m.id) : app.select(m.id))}
  ondblclick={(e) => !e.ctrlKey && !e.metaKey && app.openInWindow(m.id)}
  onkeydown={() => {}}>
  {#if showAccount && acct}
    <span class="stripe" style:background={hueColor(acct.hue, app.mode)}></span>
  {/if}
  <span class="lead">
    {#if !compact}
      <button class="avatar-wrap" onclick={(e) => stop(e, () => app.toggleCheck(m.id))} aria-label="Select">
        {#if checked}
          <span class="tick"><Check size={15} strokeWidth={3} /></span>
        {:else}
          <Avatar addr={who} size={34} />
        {/if}
      </button>
    {:else}
      <span class="udot" class:on={!m.isRead}></span>
    {/if}
  </span>

  <div class="body">
    <div class="line1">
      {#if !compact && !m.isRead}<span class="udot on inline"></span>{/if}
      <span class="from">{isSentView ? "To: " : ""}{displayName(who)}</span>
      {#if m.importance === "high" || m.ai?.priority === 3}<span class="prio" title="High priority">!</span>{/if}
      <span class="spacer"></span>
      {#if m.meetingType && m.meetingType !== "none"}<CalendarDays size={12} class="meta-ic cal" />{/if}
      {#if m.hasAttachments}<Paperclip size={12} class="meta-ic" />{/if}
      {#if m.isFlagged}<Star size={12} class="flag" fill="currentColor" />{/if}
      {#if m.snoozedUntil}
        <span class="time mono snz" title="Snoozed until {longTime(m.snoozedUntil)}"><AlarmClock size={11} /> {shortTime(m.snoozedUntil)}</span>
      {:else}
        <span class="time mono">{shortTime(m.receivedAt)}</span>
      {/if}
      <span class="hover-actions">
        <button title="Archive (e)" onclick={(e) => stop(e, () => app.archive([m.id]))}><Archive size={14} /></button>
        <button title="Delete (#)" onclick={(e) => stop(e, () => app.trash([m.id]))}><Trash2 size={14} /></button>
        <button title={m.isRead ? "Mark unread (u)" : "Mark read (u)"} onclick={(e) => stop(e, () => app.setRead([m.id], !m.isRead))}>
          {#if m.isRead}<Mail size={14} />{:else}<MailOpen size={14} />{/if}
        </button>
        <button title="Flag (s)" class:on={m.isFlagged} onclick={(e) => stop(e, () => app.toggleFlag([m.id]))}><Star size={14} /></button>
        <button title={m.snoozedUntil ? "Unsnooze" : "Snooze (z)"} onclick={(e) => stop(e, () => (m.snoozedUntil ? app.unsnooze([m.id]) : app.openSnooze([m.id])))}><AlarmClock size={14} /></button>
      </span>
    </div>
    <div class="line2">
      <span class="subject">{m.subject || "(no subject)"}</span>
      {#if showCat && cat}
        <span class="chip" style:color={cat.color} style:background="color-mix(in oklab, {cat.color} 14%, transparent)">{cat.short}</span>
      {/if}
    </div>
    {#if !compact}
      <div class="line3">
        {#if m.ai?.summary}
          <Sparkles size={11} class="ai-ic" />
          <span class="summary">{m.ai.summary}</span>
        {:else}
          <span>{m.preview}</span>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .row {
    position: relative;
    display: flex;
    gap: 12px;
    padding: 11px 14px 11px 12px;
    margin: 0 6px;
    border-radius: 10px;
    cursor: default;
    transition: background 120ms var(--ease);
  }
  .row.compact {
    padding: 8px 12px 8px 10px;
    gap: 8px;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.selected {
    background: color-mix(in oklab, var(--selection) 55%, transparent);
  }
  .row.checked {
    background: var(--active);
  }
  .stripe {
    position: absolute;
    left: 2px;
    top: 14px;
    bottom: 14px;
    width: 3px;
    border-radius: 3px;
    opacity: 0.85;
  }
  .lead {
    flex: none;
    display: flex;
    align-items: flex-start;
    padding-top: 1px;
  }
  .compact .lead {
    width: 10px;
    padding-top: 7px;
    justify-content: center;
  }
  .avatar-wrap {
    display: grid;
    border-radius: 50%;
  }
  .tick {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 18px;
  }
  .from {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unread .from {
    color: var(--fg-bright);
    font-weight: 650;
  }
  .udot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .udot.on {
    background: var(--accent);
    box-shadow: 0 0 8px rgba(var(--accent-rgb), 0.6);
  }
  .prio {
    font-weight: 800;
    color: var(--red);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .row :global(.meta-ic) {
    color: var(--muted);
    flex: none;
  }
  .row :global(.flag) {
    color: var(--accent);
    flex: none;
  }
  .time {
    font-size: 11px;
    color: var(--muted);
    flex: none;
  }
  .unread .time {
    color: var(--accent);
  }
  .hover-actions {
    display: none;
    gap: 1px;
    margin: -4px -6px -4px 0;
  }
  .hover-actions button {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    color: var(--fg-dim);
  }
  .hover-actions button:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .hover-actions button.on {
    color: var(--accent);
  }
  .row:hover .hover-actions {
    display: flex;
  }
  .row:hover .time,
  .row:hover :global(.flag),
  .row:hover :global(.meta-ic) {
    display: none;
  }
  .line2 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .subject {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unread .subject {
    color: var(--fg);
    font-weight: 550;
  }
  .line3 {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--muted);
    min-width: 0;
  }
  .line3 span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line3 :global(.ai-ic) {
    color: var(--accent);
    flex: none;
    opacity: 0.85;
  }
  .summary {
    color: color-mix(in oklab, var(--fg-dim) 85%, var(--accent));
  }
  .snz {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent);
  }
</style>
