<script lang="ts">
  import type { MessageSummary } from "$lib/types";
  import { app, CATEGORY_META } from "$lib/state/app.svelte";
  import { hueColor } from "$lib/theme";
  import { shortTime, longTime } from "$lib/util/time";
  import { displayName } from "$lib/util/misc";
  import Avatar from "./Avatar.svelte";
  import MessageStatus from "./MessageStatus.svelte";
  import { AlarmClock, Paperclip, Star, Archive, Trash2, Mail, MailOpen, Check, CalendarDays } from "@lucide/svelte";

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
  // Only the two categories that ask for a response get a mark. The rest stay in Focus.
  const showCat = $derived(
    !!cat && app.view.kind !== "category" && (m.ai?.category === "needs_reply" || m.ai?.category === "action"),
  );

  function stop(e: Event, fn: () => void) {
    e.stopPropagation();
    fn();
  }
</script>

<!-- Roving focus keeps the list one tab stop; Enter opens and Space selects. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="row"
  class:selected
  class:unread={!m.isRead}
  class:checked
  class:compact
  class:unified={showAccount}
  role="listitem"
  aria-current={selected ? "true" : undefined}
  aria-label={`${m.isRead ? "" : "Unread, "}${showCat && cat ? `${cat.label}, ` : ""}${displayName(who)}, ${m.subject || "no subject"}`}
  tabindex={selected ? 0 : -1}
  data-id={m.id}
  onclick={(e) => (e.shiftKey || e.ctrlKey || e.metaKey ? app.toggleCheck(m.id, e.shiftKey) : app.select(m.id))}
  ondblclick={(e) => !e.ctrlKey && !e.metaKey && !e.shiftKey && !(e.target as HTMLElement).closest("button, input") && app.openInWindow(m.id)}
  onkeydown={(e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === " ") { e.preventDefault(); e.stopPropagation(); app.toggleCheck(m.id, e.shiftKey); }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); app.select(m.id); if (!app.readingPane) app.openInWindow(m.id); }
  }}>
  {#if showAccount && acct}
    <span class="stripe" style:background={hueColor(acct.hue, app.mode)}></span>
  {/if}
  <span class="lead">
    <input class="row-check" type="checkbox" aria-label={`Select ${m.subject || "message"}`} checked={checked} onclick={(e) => stop(e, () => app.toggleCheck(m.id, e.shiftKey))} ondblclick={(e) => e.stopPropagation()} />
    {#if !compact}
      <button class="avatar-wrap" onclick={(e) => stop(e, () => app.toggleCheck(m.id, e.shiftKey))} aria-label={`Select message from ${displayName(who)}`} aria-pressed={checked} tabindex="-1" ondblclick={(e) => e.stopPropagation()}>
        {#if checked}
          <span class="tick"><Check size={15} strokeWidth={3} /></span>
        {:else}
          <Avatar addr={who} size={34} />
        {/if}
      </button>
    {/if}
  </span>

  <div class="body">
    <div class="line1">
      <span class="from">{isSentView ? "To: " : ""}{displayName(who)}</span>
      {#if m.importance === "high" || m.ai?.priority === 3}<span class="prio" title="High priority">!</span>{/if}
      {#if showCat && cat}<span class="pip" style:background={cat.color} title={cat.label}></span>{/if}
      <span class="spacer"></span>
      <span class="meta">
        <MessageStatus message={m} compact />
        {#if m.meetingType && m.meetingType !== "none"}<CalendarDays size={12} class="meta-ic cal" />{/if}
        {#if m.hasAttachments}<Paperclip size={12} class="meta-ic" />{/if}
        {#if m.isFlagged}<Star size={12} class="flag" fill="currentColor" />{/if}
        {#if m.snoozedUntil}
          <span class="time mono snz" title="Snoozed until {longTime(m.snoozedUntil)}"><AlarmClock size={11} /> {shortTime(m.snoozedUntil)}</span>
        {:else}
          <span class="time mono">{shortTime(m.receivedAt)}</span>
        {/if}
      </span>
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
    </div>
    {#if !compact}
      <div class="line3">
        <span>{m.ai?.summary || m.preview}</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .row {
    position: relative;
    display: flex;
    gap: 10px;
    padding: 10px 12px 10px 16px;
    margin: 1px 6px;
    border-radius: 8px;
    cursor: default;
    transition: background 120ms var(--ease);
  }
  .row.compact {
    padding: 7px 10px 7px 16px;
    gap: 8px;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.selected {
    background: color-mix(in oklab, var(--selection) 72%, transparent);
  }
  .row.checked {
    background: var(--active);
  }
  /* One mark for unread, in the same place on every row, so read mail can stay quiet. */
  .row.unread::before {
    content: "";
    position: absolute;
    left: 5px;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 3px;
    background: var(--accent);
  }
  .stripe {
    position: absolute;
    left: 5px;
    top: 14px;
    bottom: 14px;
    width: 3px;
    border-radius: 3px;
    opacity: 0.9;
  }
  .row.unified.unread::before {
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 0;
  }
  .lead {
    flex: none;
    display: flex;
    align-items: flex-start;
    padding-top: 1px;
    position: relative;
  }
  .row-check { position: absolute; inset: 9px auto auto 10px; width: 14px; height: 14px; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
  .row:hover .row-check, .row:focus-within .row-check, .row.checked .row-check, .compact .row-check { opacity: 1; }
  .row:hover .avatar-wrap, .row:focus-within .avatar-wrap, .row.checked .avatar-wrap { visibility: hidden; }
  .compact .lead {
    width: 14px;
    padding-top: 2px;
    justify-content: center;
  }
  .compact .row-check { position: static; }
  .avatar-wrap {
    display: grid;
    border-radius: 50%;
    transition: opacity var(--t);
  }
  .row:not(.unread):not(.checked) .avatar-wrap {
    opacity: 0.55;
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
    font-weight: 450;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unread .from {
    color: var(--fg-bright);
    font-weight: 650;
  }
  .pip {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    min-width: 0;
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
    font-variant-numeric: tabular-nums;
  }
  .unread .time {
    color: var(--fg-dim);
    font-weight: 600;
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
  .row:hover .hover-actions, .row:focus-within .hover-actions {
    display: flex;
  }
  .row:hover .meta,
  .row:focus-within .meta {
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
    font-size: 12.5px;
    font-weight: 450;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unread .subject {
    color: var(--fg);
    font-weight: 560;
  }
  .line3 {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }
  .unread .line3 {
    color: var(--fg-dim);
  }
  .line3 span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .snz {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent);
  }
</style>
