<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { dateGroup } from "$lib/util/time";
  import MessageRow from "./MessageRow.svelte";
  import { Archive, Trash2, MailOpen, Star, X, Paperclip, AlarmClock, LoaderCircle, Sparkles, Inbox, PanelRightClose, PanelRightOpen } from "@lucide/svelte";
  import { tick } from "svelte";

  let scroller: HTMLDivElement | undefined = $state();
  let sentinel: HTMLDivElement | undefined = $state();

  const filtered = $derived(app.unreadOnly || app.flaggedOnly || app.attachmentsOnly);
  const allChecked = $derived(app.messages.length > 0 && app.messages.every(m => app.checked.has(m.id)));
  const compact = $derived(app.settings?.ui.density === "compact");

  const groups = $derived.by(() => {
    const out: { label: string; items: typeof app.messages }[] = [];
    const ordered = app.view.kind === "search" || app.view.kind === "results";
    for (const m of app.messages) {
      const label = ordered ? "" : dateGroup(m.receivedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  });

  // Infinite scroll.
  $effect(() => {
    if (!sentinel || !scroller || app.listError) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) app.loadMore();
      },
      { root: scroller, rootMargin: "600px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  });

  // Keep the selected row visible during keyboard navigation.
  $effect(() => {
    const id = app.selectedId;
    if (!id || !scroller) return;
    tick().then(() => {
      const el = scroller?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  // Reset scroll on view change.
  $effect(() => {
    void app.view;
    scroller?.scrollTo({ top: 0 });
  });

  const emptyText = $derived.by(() => {
    if (filtered) return { title: "No messages match", sub: "Clear your filters to see all mail in this view." };
    switch (app.view.kind) {
      case "results":
      case "search":
        return { title: "No matches", sub: "Try fewer words, or ask Tern to dig deeper." };
      case "category":
        return { title: "Nothing here", sub: app.aiReady ? "New mail is sorted as it arrives." : "Set up AI to sort mail automatically." };
      case "flagged":
        return { title: "No flagged mail", sub: "Press s to flag a message." };
      case "snoozed":
        return { title: "Nothing snoozed", sub: "Snooze a message to return to it at a better time." };
      default:
        return app.view.kind === "unified" && app.view.wellKnown === "inbox"
          ? { title: "You’re all caught up", sub: "New messages will appear here." }
          : { title: "No messages here", sub: "Messages in this folder will appear here." };
    }
  });
</script>

<section class="list">
  <header>
    {#if app.checked.size}
      <div class="bulk">
        <button class="icon-btn" title="Clear selection" onclick={() => (app.checked = new Set())}><X size={15} /></button>
        <span class="n">{app.checked.size} selected</span>
        <span class="spacer"></span>
        <button class="icon-btn" title="Archive (e)" onclick={() => app.archive()}><Archive size={15} /></button>
        <button class="icon-btn" title="Mark selected messages read" aria-label="Mark selected messages read" onclick={() => app.setRead([...app.checked], true)}><MailOpen size={15} /></button>
        <button class="icon-btn" title="Snooze selected messages" aria-label="Snooze selected messages" onclick={() => app.openSnooze()}><AlarmClock size={15} /></button>
        <button class="icon-btn" title="Toggle flag" onclick={() => app.toggleFlag()}><Star size={15} /></button>
        <button class="icon-btn" title="Delete (#)" onclick={() => app.trash()}><Trash2 size={15} /></button>
      </div>
    {:else}
      <div class="title">
        <h1>{app.viewTitle}</h1>
        {#if app.view.kind === "results"}
          <span class="badge"><Sparkles size={11} /> from Tern</span>
        {/if}
      </div>
      <div class="tools">
        {#if app.loading}<LoaderCircle size={14} class="spin muted" />{/if}
        <button
          class="icon-btn"
          title={app.readingPane ? "Hide reading pane — open messages in their own window (p)" : "Show reading pane (p)"}
          onclick={() => app.toggleReadingPane()}>
          {#if app.readingPane}<PanelRightClose size={14} />{:else}<PanelRightOpen size={14} />{/if}
        </button>
      </div>
    {/if}
  </header>

  <div class="filter-bar">
    <input type="checkbox" aria-label="Select all loaded messages" title="Select all loaded messages (Ctrl+A)" checked={allChecked} indeterminate={app.checked.size > 0 && !allChecked} disabled={!app.messages.length || app.loading} onchange={() => app.selectAllLoaded()} />
    <div class="filters" role="group" aria-label="Filter messages">
      <button class:active={!filtered} aria-pressed={!filtered} onclick={() => app.clearMailFilters()}>All</button>
      <button class:active={app.unreadOnly} aria-pressed={app.unreadOnly} title="Unread only (U)" onclick={() => app.toggleUnreadOnly()}>Unread</button>
      <button class:active={app.flaggedOnly} aria-pressed={app.flaggedOnly} onclick={() => app.toggleMailFilter("flaggedOnly")}><Star size={12} /> Flagged</button>
      <button class:active={app.attachmentsOnly} aria-pressed={app.attachmentsOnly} onclick={() => app.toggleMailFilter("attachmentsOnly")}><Paperclip size={12} /> Files</button>
    </div>
  </div>

  <div class="scroll" bind:this={scroller} role="list" aria-label="Messages" aria-busy={app.loading}>
    {#if app.listError}
      <div class="list-error" role="alert"><strong>Couldn’t load messages</strong><span>{app.listError}</span><button class="btn sm" onclick={() => app.retryList()}>Try again</button></div>
    {/if}
    {#each groups as g, gi (g.label + gi)}
      {#if g.label}<div class="group eyebrow">{g.label}</div>{/if}
      {#each g.items as m (m.id)}
        <MessageRow
          {m}
          {compact}
          selected={m.id === app.selectedId}
          checked={app.checked.has(m.id)}
          showAccount={app.isUnifiedView} />
      {/each}
    {/each}

    {#if !app.messages.length && !app.loading && !app.listError}
      <div class="empty">
        <div class="glyph"><Inbox size={26} strokeWidth={1.4} /></div>
        <div class="et">{emptyText.title}</div>
        <div class="hint">{emptyText.sub}</div>
        {#if filtered}<button class="btn sm" onclick={() => app.clearMailFilters()}>Clear filters</button>{/if}
      </div>
    {/if}

    {#if app.loading && !app.messages.length}<div class="initial-loading" role="status"><LoaderCircle size={16} class="spin" /> Loading messages…</div>{/if}
    <div bind:this={sentinel} class="sentinel"></div>
    {#if app.loading && app.messages.length}
      <div class="more"><LoaderCircle size={14} class="spin" /></div>
    {/if}
  </div>
  <footer><span>{app.checked.size ? `${app.checked.size} selected · ${app.messages.length} loaded` : `${app.messages.length}${app.hasMore ? "+" : ""} messages`}</span><span title="Use j and k to navigate; e to archive">j / k navigate · e archive</span></footer>
</section>

<style>
  .filter-bar { display: flex; align-items: center; gap: 10px; padding: 0 16px 12px; border-bottom: 1px solid var(--line); }
  .filter-bar input { margin: 0; flex: none; width: 14px; height: 14px; cursor: pointer; }
  .filters { display: flex; gap: 3px; flex-wrap: wrap; }
  .filters button { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 4px; font-size: 11.5px; color: var(--muted); }
  .filters button:hover { color: var(--fg); background: var(--hover); }
  .filters button.active { color: var(--fg-bright); background: var(--hover); box-shadow: inset 0 -2px var(--accent); }
  footer { display: flex; justify-content: space-between; gap: 8px; padding: 8px 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 10px; flex-wrap: wrap; }
  .list-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 18px; color: var(--red); overflow-wrap: anywhere; }
  .initial-loading { display: flex; justify-content: center; gap: 8px; padding: 48px 16px; color: var(--muted); }
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    border-right: 1px solid var(--line);
    background: var(--surface);
  }
  header {
    height: 52px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px 0 20px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 680;
    letter-spacing: -0.015em;
    color: var(--fg-bright);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .tools :global(.muted) {
    color: var(--muted);
    margin-right: 4px;
  }
  .bulk {
    display: flex;
    align-items: center;
    gap: 2px;
    width: 100%;
    margin-left: -10px;
  }
  .bulk .n {
    font-weight: 600;
    color: var(--accent);
    margin-left: 4px;
  }
  .spacer {
    flex: 1;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 24px;
  }
  .group {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 10px 20px 6px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 80px 20px;
    text-align: center;
    animation: fade-up 240ms var(--ease);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 6px;
    margin-bottom: 8px;
    color: var(--accent);
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .et {
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
  }
  .sentinel {
    height: 1px;
  }
  .more {
    display: grid;
    place-items: center;
    padding: 12px;
    color: var(--muted);
  }
</style>
