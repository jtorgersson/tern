<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { dateGroup } from "$lib/util/time";
  import MessageRow from "./MessageRow.svelte";
  import { Archive, Trash2, MailOpen, Star, X, Filter, LoaderCircle, Sparkles, Inbox } from "@lucide/svelte";
  import { tick } from "svelte";

  let scroller: HTMLDivElement | undefined = $state();
  let sentinel: HTMLDivElement | undefined = $state();

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
    if (!sentinel || !scroller) return;
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
    switch (app.view.kind) {
      case "search":
        return { title: "No matches", sub: "Try fewer words, or ask Tern to dig deeper." };
      case "category":
        return { title: "Nothing here", sub: app.aiReady ? "New mail is sorted as it arrives." : "Set up AI to sort mail automatically." };
      case "flagged":
        return { title: "No flagged mail", sub: "Press s to flag a message." };
      default:
        return app.unreadOnly
          ? { title: "All caught up", sub: "No unread messages here." }
          : { title: "Inbox zero", sub: "Enjoy the quiet." };
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
        <button class="icon-btn" title="Mark read" onclick={() => app.setRead([...app.checked], true)}><MailOpen size={15} /></button>
        <button class="icon-btn" title="Flag" onclick={() => app.toggleFlag()}><Star size={15} /></button>
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
        <button class="icon-btn" class:on={app.unreadOnly} title="Unread only (U)" onclick={() => app.toggleUnreadOnly()}>
          <Filter size={14} />
        </button>
      </div>
    {/if}
  </header>

  <div class="scroll" bind:this={scroller} role="listbox" aria-label="Messages">
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

    {#if !app.messages.length && !app.loading}
      <div class="empty">
        <div class="glyph"><Inbox size={26} strokeWidth={1.4} /></div>
        <div class="et">{emptyText.title}</div>
        <div class="hint">{emptyText.sub}</div>
      </div>
    {/if}

    <div bind:this={sentinel} class="sentinel"></div>
    {#if app.loading && app.messages.length}
      <div class="more"><LoaderCircle size={14} class="spin" /></div>
    {/if}
  </div>
</section>

<style>
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
    background: linear-gradient(var(--surface) 70%, transparent);
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
    border-radius: 18px;
    margin-bottom: 8px;
    color: var(--accent);
    background: radial-gradient(circle at 30% 20%, var(--accent-soft), transparent 70%);
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
