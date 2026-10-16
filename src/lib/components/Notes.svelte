<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
  import {
    NotebookPen,
    Plus,
    Search,
    Sparkles,
    Pin,
    Archive,
    Trash2,
    Image as ImageIcon,
    FileText,
    FolderOpen,
    LoaderCircle,
    ArrowUp,
    X,
  } from "@lucide/svelte";
  import { app } from "$lib/state/app.svelte";
  import { notes } from "$lib/state/notes.svelte";
  import { api } from "$lib/api";
  import { askNotes, organizeNotes } from "$lib/ai";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { relative } from "$lib/util/time";
  import { errMsg } from "$lib/util/misc";
  import QuickCapture from "./QuickCapture.svelte";
  import type { Note } from "$lib/types";

  const PALETTE = ["var(--accent)", "var(--blue)", "var(--cyan)", "var(--green)", "var(--orange)", "var(--magenta)", "var(--red)", "var(--yellow)"];

  function catColor(name: string): string {
    let h = 0;
    for (const c of name) h = (h * 33 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length]!;
  }

  function src(n: Note): string {
    return n.kind === "image" && n.sourcePath ? convertFileSrc(n.sourcePath) : "";
  }

  let searchEl = $state<HTMLInputElement | undefined>();
  let title = $state("");
  let body = $state("");
  let category = $state("Inbox");
  let tagText = $state("");
  let loadedFor = $state<string | null>(null);
  let organizing = $state(false);
  let reading = $state(false);
  let status = $state("");
  let ask = $state("");
  let answer = $state("");
  let asking = $state(false);
  let askAbort: AbortController | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    if (!notes.items.length && !notes.loading) notes.load();
    const timer = setInterval(() => notes.refreshIfChanged(), 4000);
    const onFocus = () => notes.refreshIfChanged();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      clearTimeout(saveTimer);
      askAbort?.abort();
    };
  });

  $effect(() => {
    const n = notes.selected;
    if (!n || n.id === loadedFor) return;
    loadedFor = n.id;
    title = n.title;
    body = n.body;
    category = n.category || "Inbox";
    tagText = n.tags.join(", ");
    status = "";
  });

  $effect(() => {
    notes.searchTick;
    untrack(() => searchEl?.focus());
  });

  const open = $derived(notes.selected);
  const categories = $derived(notes.facets.map((f) => f.category));
  const heading = $derived(notes.archived ? "Archive" : notes.category || "All notes");

  function tags(): string[] {
    return tagText.split(",").map((t) => t.trim()).filter(Boolean);
  }

  function scheduleSave() {
    const n = notes.selected;
    if (!n || loadedFor !== n.id) return;
    clearTimeout(saveTimer);
    const id = n.id;
    saveTimer = setTimeout(() => {
      notes.save({ id, title, body: n.kind === "image" ? n.body : body, category, tags: tags() }).catch((e) => (status = errMsg(e)));
    }, 420);
  }

  async function organize(only?: Note) {
    if (!app.aiReady) {
      app.openSettings("ai");
      return;
    }
    organizing = !only;
    reading = !!only;
    status = "";
    try {
      const batch = only
        ? [only.body ? only : await api.note(only.id)]
        : await api
            .notesList({ unanalyzed: true, category: notes.category, kind: notes.kind, archived: false, limit: 12 })
            .then((page) => Promise.all(page.notes.map((n) => api.note(n.id))));
      if (!batch.length) {
        status = "Everything here is already filed.";
        return;
      }
      const images = new Map<string, { mediaType: string; base64: string }>();
      for (const n of batch) {
        if (n.kind !== "image") continue;
        const img = await api.notesImage(n.id);
        if (img) images.set(n.id, img);
      }
      const insights = await organizeNotes(batch, images, categories);
      if (insights.length) await api.notesApply(insights);
      status = insights.length ? `Filed ${insights.length}.` : "Nothing new to file.";
      await notes.load({ silent: true });
      if (notes.selectedId) {
        loadedFor = null;
        notes.selected = await api.note(notes.selectedId);
      }
    } catch (e) {
      status = errMsg(e);
    } finally {
      organizing = false;
      reading = false;
    }
  }

  async function submitAsk() {
    const q = ask.trim();
    if (!q) return;
    if (!app.aiReady) {
      app.openSettings("ai");
      return;
    }
    askAbort?.abort();
    const ctrl = new AbortController();
    askAbort = ctrl;
    asking = true;
    answer = "";
    try {
      const context = [notes.selected, ...notes.items.filter((n) => n.id !== notes.selectedId)].filter((n): n is Note => !!n);
      for await (const delta of askNotes(q, context, ctrl.signal)) answer += delta;
    } catch (e) {
      if ((e as Error).name !== "AbortError") answer = errMsg(e);
    } finally {
      asking = false;
    }
  }

  function reveal(n: Note) {
    if (!n.sourcePath) return;
    revealItemInDir(n.sourcePath).catch(() => openPath(n.sourcePath!));
  }
</script>

<div class="notes">
  <header>
    <div class="titleblock">
      <div class="eyebrow">Library</div>
      <h1>{heading}</h1>
      <p>
        {notes.total} {notes.total === 1 ? "note" : "notes"}
        {#if notes.unanalyzed && !notes.archived}<span> · {notes.unanalyzed} still unread by Tern</span>{/if}
      </p>
    </div>
    <label class="search">
      <Search size={14} />
      <input bind:this={searchEl} placeholder="Search notes" value={notes.q} oninput={(e) => notes.setQuery(e.currentTarget.value)} />
    </label>
    <div class="actions">
      <div class="seg" role="group" aria-label="Kind">
        <button class:on={notes.kind === null} onclick={() => notes.setKind(null)}>All</button>
        <button class:on={notes.kind === "text"} onclick={() => notes.setKind("text")}><FileText size={13} /> Writing</button>
        <button class:on={notes.kind === "image"} onclick={() => notes.setKind("image")}><ImageIcon size={13} /> Pictures</button>
      </div>
      <select class="field sort" aria-label="Sort" value={notes.sort} onchange={(e) => notes.setSort(e.currentTarget.value as "updated" | "created" | "title")}>
        <option value="updated">Recent</option>
        <option value="created">Created</option>
        <option value="title">Title</option>
      </select>
      <button class="btn" onclick={() => notes.importOneDrive()} disabled={notes.importing}>
        {#if notes.importing}<LoaderCircle size={14} class="spin" />{:else}<FolderOpen size={14} />{/if}
        OneDrive/notes
      </button>
      <button class="btn" onclick={() => organize()} disabled={organizing}>
        {#if organizing}<LoaderCircle size={14} class="spin" />{:else}<Sparkles size={14} />{/if}
        Organize
      </button>
      <button class="btn primary" onclick={() => notes.startCapture()}><Plus size={14} /> New note</button>
    </div>
  </header>

  <div class="body" class:reading={!!open}>
    <aside class="rail">
      <button class="cat" class:active={!notes.archived && !notes.category} onclick={() => notes.setCategory(null)}>
        <span class="swatch" style:background="var(--accent)"></span>
        <span>All</span>
      </button>
      {#each notes.facets as f (f.category)}
        <button class="cat" class:active={!notes.archived && notes.category === f.category} onclick={() => notes.setCategory(f.category)}>
          <span class="swatch" style:background={catColor(f.category)}></span>
          <span class="name">{f.category}</span>
          <span class="count">{f.count}</span>
        </button>
      {/each}
      <button class="cat archive" class:active={notes.archived} onclick={() => notes.showArchive()}>
        <Archive size={13} />
        <span>Archive</span>
        {#if notes.archivedCount}<span class="count">{notes.archivedCount}</span>{/if}
      </button>
    </aside>

    <section class="stream">
      {#if notes.error}
        <div class="empty">
          <p>{notes.error}</p>
          <button class="btn" onclick={() => notes.load()}>Try again</button>
        </div>
      {:else if notes.loading && !notes.items.length}
        <div class="empty quiet"><LoaderCircle size={18} class="spin" /> Gathering notes</div>
      {:else if !notes.items.length}
        <div class="empty">
          <div class="glyph"><NotebookPen size={28} /></div>
          <h2>Nothing filed here yet</h2>
          <p>Press <kbd>Super</kbd> <kbd>N</kbd> from anywhere, or run <span class="mono">tern note "…"</span> in a terminal. Text and pictures in OneDrive/notes can be brought in too.</p>
          <div class="empty-actions">
            <button class="btn primary" onclick={() => notes.startCapture()}>New note</button>
            <button class="btn" onclick={() => notes.importOneDrive()} disabled={notes.importing}>Import OneDrive/notes</button>
          </div>
        </div>
      {:else}
        <div class="grid" class:slim={!!open}>
          {#each notes.items as n (n.id)}
            <button class="card" class:active={n.id === notes.selectedId} class:pic={n.kind === "image"} onclick={() => notes.select(n.id)}>
              {#if n.kind === "image" && n.sourcePath}
                <img src={src(n)} alt="" loading="lazy" />
              {/if}
              <div class="card-body">
                <div class="meta">
                  <span class="pill" style:color={catColor(n.category)}>{n.category}</span>
                  {#if n.pinned}<Pin size={12} class="pin" />{/if}
                  <span class="when">{relative(n.updatedAt)}</span>
                </div>
                <strong>{n.title}</strong>
                {#if n.summary}<em>{n.summary}</em>{:else if n.excerpt && n.kind !== "image"}<span class="excerpt">{n.excerpt}</span>{/if}
                {#if n.tags.length}
                  <div class="tags">{#each n.tags as t (t)}<span>#{t}</span>{/each}</div>
                {/if}
              </div>
            </button>
          {/each}
        </div>
        {#if notes.hasMore}
          <button class="btn more" onclick={() => notes.loadMore()}>Show more</button>
        {/if}
      {/if}
    </section>

    {#if open}
      <article class="reader">
        <div class="reader-bar">
          <button class="icon-btn" title="Pin" aria-label="Pin" class:on={open.pinned} onclick={() => notes.togglePin()}><Pin size={15} /></button>
          <button class="icon-btn" title="Archive" aria-label="Archive" onclick={() => notes.archiveSelected()}><Archive size={15} /></button>
          {#if open.sourcePath}
            <button class="icon-btn" title="Show in folder" aria-label="Show in folder" onclick={() => reveal(open)}><FolderOpen size={15} /></button>
          {/if}
          <button class="btn sm" onclick={() => organize(open)} disabled={reading}>
            {#if reading}<LoaderCircle size={13} class="spin" />{:else}<Sparkles size={13} />{/if}
            Read
          </button>
          <span class="spacer"></span>
          <button class="icon-btn" title="Delete" aria-label="Delete" onclick={() => notes.deleteSelected()}><Trash2 size={15} /></button>
          <button class="icon-btn" title="Close" aria-label="Close note" onclick={() => notes.select(null)}><X size={15} /></button>
        </div>
        {#if open.kind === "image" && open.sourcePath}
          <img class="hero" src={src(open)} alt={open.title} />
        {/if}
        <input class="headline" bind:value={title} oninput={scheduleSave} aria-label="Title" />
        <div class="file-row">
          <select class="field" bind:value={category} onchange={scheduleSave} aria-label="Category">
            {#each [...new Set([category, ...categories, "Inbox", "Ideas", "Work", "Personal", "Reference", "Media"])] as c (c)}
              <option value={c}>{c}</option>
            {/each}
          </select>
          <input class="field tags" bind:value={tagText} placeholder="tags, comma separated" oninput={scheduleSave} aria-label="Tags" />
        </div>
        {#if open.summary}
          <p class="summary"><Sparkles size={13} /> {open.summary}</p>
        {/if}
        {#if open.kind === "image"}
          <p class="path">{open.sourcePath}</p>
        {:else}
          <textarea class="sheet" bind:value={body} oninput={scheduleSave} placeholder="Write…" aria-label="Note"></textarea>
          {#if body.trim()}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="prose" onclick={mdLinkHandler}>{@html md(body)}</div>
          {/if}
        {/if}
        {#if status}<p class="status">{status}</p>{/if}
      </article>
    {/if}
  </div>

  <form class="ask" onsubmit={(e) => { e.preventDefault(); submitAsk(); }}>
    {#if answer || asking}
      <div class="answer">
        {#if asking && !answer}<LoaderCircle size={14} class="spin" />{/if}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="prose" onclick={mdLinkHandler}>{@html md(answer)}</div>
      </div>
    {/if}
    <div class="ask-row">
      <Sparkles size={15} />
      <input bind:value={ask} placeholder={app.aiReady ? "Ask Tern about these notes" : "Set up AI to ask about your notes"} disabled={asking} />
      <button class="icon-btn on" type="submit" aria-label="Ask" disabled={asking || !ask.trim()}><ArrowUp size={15} /></button>
    </div>
  </form>
</div>

{#if notes.captureOpen}
  <QuickCapture mode="overlay" />
{/if}

<style>
  .notes {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(1200px 420px at 10% -10%, color-mix(in oklab, var(--accent) 12%, transparent), transparent 55%),
      var(--bg);
  }
  header {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    padding: 22px 22px 14px;
    border-bottom: 1px solid var(--line);
  }
  .titleblock { min-width: 180px; }
  .eyebrow {
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h1 {
    margin: 2px 0 0;
    font-size: 28px;
    font-weight: 560;
    letter-spacing: -0.04em;
    line-height: 1.05;
  }
  .titleblock p { margin: 4px 0 0; color: var(--muted); font-size: 12.5px; }
  .search {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--muted);
    margin-bottom: 2px;
  }
  .search input {
    flex: 1;
    border: 0;
    outline: none;
    background: transparent;
    min-width: 0;
  }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .seg {
    display: flex;
    padding: 2px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .seg button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .seg button.on { background: var(--bg-lighter); color: var(--fg); }
  .sort { width: auto; height: 32px; }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 196px minmax(0, 1fr);
  }
  .body.reading { grid-template-columns: 180px minmax(240px, 0.9fr) minmax(320px, 1.15fr); }
  .rail {
    overflow: auto;
    padding: 12px 10px 18px;
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cat {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 8px;
    border-radius: 8px;
    color: var(--fg-dim);
    text-align: left;
  }
  .cat:hover { background: var(--hover); color: var(--fg); }
  .cat.active { background: var(--active); color: var(--fg); }
  .cat .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cat .count { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
  .swatch { width: 7px; height: 7px; border-radius: 99px; flex: none; }
  .cat.archive { margin-top: 8px; }
  .stream { overflow: auto; padding: 16px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 12px;
    align-content: start;
  }
  .grid.slim { grid-template-columns: 1fr; }
  .card {
    display: flex;
    flex-direction: column;
    text-align: left;
    border-radius: 14px;
    overflow: hidden;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: inset 0 0 0 1px var(--line);
    transition: transform 160ms var(--ease), box-shadow 160ms var(--ease);
  }
  .card:hover { transform: translateY(-2px); box-shadow: var(--shadow-sm); }
  .card.active { box-shadow: inset 0 0 0 1px var(--accent-line), var(--shadow-sm); }
  .card img {
    width: 100%;
    height: 148px;
    object-fit: cover;
    background: var(--bg-darker);
  }
  .grid.slim .card { flex-direction: row; }
  .grid.slim .card img { width: 92px; height: 72px; }
  .card-body { display: flex; flex-direction: column; gap: 4px; padding: 12px 12px 14px; min-width: 0; }
  .meta { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
  .pill { font-weight: 600; letter-spacing: 0.02em; }
  .when { margin-left: auto; }
  .card strong {
    font-size: 14.5px;
    font-weight: 560;
    letter-spacing: -0.02em;
    line-height: 1.25;
  }
  .card em, .excerpt {
    color: var(--fg-dim);
    font-style: normal;
    font-size: 12.5px;
    line-height: 1.4;
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tags span { color: var(--muted); font-size: 11px; }
  :global(.pin) { color: var(--accent); }
  .more { margin: 16px auto 0; display: flex; }
  .empty {
    min-height: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 8px;
    color: var(--fg-dim);
    padding: 24px;
  }
  .empty.quiet { flex-direction: row; min-height: 240px; }
  .glyph {
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    border-radius: 20px;
    background: var(--accent-soft);
    color: var(--accent);
    margin-bottom: 6px;
  }
  .empty h2 { margin: 0; color: var(--fg); font-weight: 560; letter-spacing: -0.03em; }
  .empty p { max-width: 420px; margin: 0; line-height: 1.5; }
  .empty-actions { display: flex; gap: 8px; margin-top: 8px; }
  .reader {
    min-width: 0;
    overflow: auto;
    padding: 16px 22px 28px;
    border-left: 1px solid var(--line);
    background: color-mix(in oklab, var(--bg-dark) 35%, transparent);
  }
  .reader-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
  .spacer { flex: 1; }
  .hero {
    width: 100%;
    max-height: 420px;
    object-fit: contain;
    border-radius: 14px;
    background: var(--bg-darker);
    margin-bottom: 12px;
  }
  .headline {
    width: 100%;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 30px;
    font-weight: 560;
    letter-spacing: -0.045em;
    line-height: 1.1;
    color: var(--fg-bright);
    user-select: text;
  }
  .file-row { display: flex; gap: 8px; margin: 12px 0; }
  .file-row .field { flex: 1; }
  .summary {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 0 0 14px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--fg);
    line-height: 1.45;
  }
  .sheet {
    width: 100%;
    min-height: 140px;
    resize: vertical;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 15.5px;
    line-height: 1.55;
    user-select: text;
    -webkit-user-select: text;
  }
  .prose {
    user-select: text;
    -webkit-user-select: text;
    line-height: 1.55;
    color: var(--fg);
  }
  .prose :global(p) { margin: 0.4em 0; }
  .prose :global(h1), .prose :global(h2), .prose :global(h3) { letter-spacing: -0.03em; line-height: 1.2; }
  .path { color: var(--muted); font-size: 12px; word-break: break-all; }
  .status { color: var(--fg-dim); font-size: 12.5px; }
  .ask {
    border-top: 1px solid var(--line);
    padding: 10px 16px 14px;
    background: color-mix(in oklab, var(--bg-dark) 65%, transparent);
  }
  .answer { padding: 4px 8px 8px 28px; max-height: 180px; overflow: auto; }
  .ask-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 8px 0 14px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--accent);
  }
  .ask-row input { flex: 1; border: 0; outline: none; background: transparent; color: var(--fg); min-width: 0; }
  @media (prefers-reduced-motion: reduce) {
    .card { transition: none; }
    .card:hover { transform: none; }
  }
  @media (max-width: 1100px) {
    header { flex-wrap: wrap; }
    .body, .body.reading { grid-template-columns: 1fr; }
    .rail { flex-direction: row; overflow: auto; border-right: 0; border-bottom: 1px solid var(--line); }
    .cat { flex: none; }
    .reader { border-left: 0; border-top: 1px solid var(--line); }
  }
</style>
