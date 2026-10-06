<script lang="ts">
  import { app, CATEGORY_META, SMART_CATEGORIES, wkLabel, type UiView } from "$lib/state/app.svelte";
  import { hueColor } from "$lib/theme";
  import { relative } from "$lib/util/time";
  import type { Folder, WellKnownFolder } from "$lib/types";
  import {
    Inbox,
    Star,
    Send,
    FileText,
    Archive,
    Trash2,
    ShieldAlert,
    Folder as FolderIcon,
    ChevronRight,
    Sparkles,
    Layers,
    Plus,
    Sun,
    CalendarDays,
  } from "@lucide/svelte";
  import { today } from "$lib/state/today.svelte";
  import { calendar } from "$lib/state/calendar.svelte";

  const MAILBOXES: { wk: WellKnownFolder; icon: typeof Inbox }[] = [
    { wk: "inbox", icon: Inbox },
    { wk: "drafts", icon: FileText },
    { wk: "sentitems", icon: Send },
    { wk: "archive", icon: Archive },
    { wk: "deleteditems", icon: Trash2 },
    { wk: "junkemail", icon: ShieldAlert },
  ];

  let collapsed = $state<Record<string, boolean>>({});
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  function isActive(v: UiView): boolean {
    return JSON.stringify(v) === JSON.stringify(app.view);
  }

  interface Node {
    folder: Folder;
    children: Node[];
  }

  function tree(accountId: string): Node[] {
    const fs = app.folders.filter((f) => f.accountId === accountId && !f.wellKnown);
    const byParent = new Map<string | null, Folder[]>();
    const ids = new Set(fs.map((f) => f.id));
    for (const f of fs) {
      const p = f.parentId && ids.has(f.parentId) ? f.parentId : null;
      byParent.set(p, [...(byParent.get(p) ?? []), f]);
    }
    const build = (p: string | null): Node[] =>
      (byParent.get(p) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((folder) => ({ folder, children: build(folder.id) }));
    return build(null);
  }

  const visibleAccounts = $derived(
    app.accountFilter ? app.accounts.filter((a) => a.id === app.accountFilter) : app.accounts,
  );
  const hasCategories = $derived(Object.values(app.categoryCounts).some((n) => (n ?? 0) > 0));
  const lastSync = $derived(
    app.accounts
      .map((a) => app.syncStatus[a.id]?.lastSync ?? a.lastSync)
      .filter(Boolean)
      .sort()
      .pop() ?? null,
  );
</script>

{#snippet folderNode(node: Node, depth: number)}
  {@const v: UiView = { kind: "folder", folderId: node.folder.id }}
  <button class="item" class:active={isActive(v)} style:padding-left="{12 + depth * 14}px" onclick={() => app.setView(v)}>
    <FolderIcon size={14} />
    <span class="name">{node.folder.name}</span>
    {#if node.folder.unread}<span class="count">{node.folder.unread}</span>{/if}
  </button>
  {#each node.children as child (child.folder.id)}
    {@render folderNode(child, depth + 1)}
  {/each}
{/snippet}

<nav class="sidebar">
  {#if app.accounts.length > 1}
    <div class="accounts">
      <button class="acct" class:active={!app.accountFilter} onclick={() => app.setAccountFilter(null)} title="All accounts">
        <Layers size={13} />
        <span>All</span>
      </button>
      {#each app.accounts as a (a.id)}
        <button
          class="acct"
          class:active={app.accountFilter === a.id}
          onclick={() => app.setAccountFilter(app.accountFilter === a.id ? null : a.id)}
          title={a.email}>
          <span class="dot" style:background={hueColor(a.hue, app.mode)}></span>
          <span>{a.displayName || a.email.split("@")[0]}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="scroll">
    <section>
      <button class="item today" class:active={isActive({ kind: "today" })} onclick={() => app.setView({ kind: "today" })}>
        <Sun size={15} />
        <span class="name">Today</span>
        {#if today.needsReply.length}<span class="count strong">{today.needsReply.length}</span>{/if}
      </button>
      <button class="item" class:active={isActive({ kind: "agenda" })} onclick={() => app.setView({ kind: "agenda" })}>
        <CalendarDays size={15} />
        <span class="name">Calendar</span>
        {#if calendar.unanswered.length}<span class="count strong" title="Invitations awaiting your response">{calendar.unanswered.length}</span>{:else if calendar.todayMeetings.length}<span class="count">{calendar.todayMeetings.length}</span>{/if}
      </button>
      {#each MAILBOXES as m (m.wk)}
        {@const v: UiView = { kind: "unified", wellKnown: m.wk }}
        {@const unread = m.wk === "inbox" || m.wk === "junkemail" ? app.unifiedUnread(m.wk) : 0}
        <button class="item" class:active={isActive(v)} onclick={() => app.setView(v)}>
          <m.icon size={15} />
          <span class="name">{wkLabel(m.wk)}</span>
          {#if unread}<span class="count" class:strong={m.wk === "inbox"}>{unread}</span>{/if}
        </button>
        {#if m.wk === "inbox"}
          <button class="item" class:active={isActive({ kind: "flagged" })} onclick={() => app.setView({ kind: "flagged" })}>
            <Star size={15} />
            <span class="name">Flagged</span>
          </button>
        {/if}
      {/each}
    </section>

    <section>
      <div class="heading">
        <Sparkles size={11} />
        <span class="eyebrow">Smart inbox</span>
      </div>
      {#if app.aiReady || hasCategories}
        {#each SMART_CATEGORIES as c (c)}
          {@const v: UiView = { kind: "category", category: c }}
          {@const n = app.categoryCounts[c] ?? 0}
          <button class="item" class:active={isActive(v)} class:dim={!n} onclick={() => app.setView(v)}>
            <span class="cat" style:background={CATEGORY_META[c].color}></span>
            <span class="name">{CATEGORY_META[c].label}</span>
            {#if n}<span class="count" class:strong={c === "needs_reply"}>{n}</span>{/if}
          </button>
        {/each}
      {:else}
        <button class="setup" onclick={() => app.openSettings("ai")}>
          <span>Let AI sort your inbox into <em>Needs reply</em>, <em>FYI</em>, <em>Newsletters</em>…</span>
          <span class="link">Set up AI →</span>
        </button>
      {/if}
    </section>

    {#each visibleAccounts as a (a.id)}
      {@const nodes = tree(a.id)}
      {#if nodes.length}
        <section>
          <button class="heading toggle" onclick={() => (collapsed[a.id] = !collapsed[a.id])}>
            <span class="chev" class:open={!collapsed[a.id]}><ChevronRight size={11} /></span>
            <span class="eyebrow">{app.accounts.length > 1 ? a.displayName || a.email : "Folders"}</span>
          </button>
          {#if !collapsed[a.id]}
            {#each nodes as n (n.folder.id)}
              {@render folderNode(n, 0)}
            {/each}
          {/if}
        </section>
      {/if}
    {/each}
  </div>

  <footer>
    <span class="sync" title={app.accounts.map((a) => `${a.email}: ${app.syncStatus[a.id]?.state ?? a.status}`).join("\n")}>
      <span class="pulse" class:busy={app.isSyncing} class:err={app.accounts.some((a) => (app.syncStatus[a.id]?.state ?? a.status) === "error")}></span>
      {app.isSyncing ? "Syncing…" : `Synced ${relative(lastSync, now)}`}
    </span>
    <button class="icon-btn small" title="Add account" aria-label="Add account" onclick={() => app.openSettings("accounts")}>
      <Plus size={14} />
    </button>
    <button class="keys" onclick={() => (app.cheatsheetOpen = true)} title="Keyboard shortcuts"><kbd>?</kbd></button>
  </footer>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    border-right: 1px solid var(--line);
  }
  .accounts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 10px 10px 4px;
  }
  .acct {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--fg-dim);
    box-shadow: inset 0 0 0 1px var(--line);
    max-width: 100%;
    transition: all var(--t);
  }
  .acct span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .acct:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .acct.active {
    color: var(--fg-bright);
    background: var(--active);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 6px 8px 12px;
  }
  section {
    padding: 6px 0;
  }
  section + section {
    border-top: 1px solid color-mix(in oklab, var(--fg) 5%, transparent);
  }
  .heading {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 6px;
    color: var(--muted);
    width: 100%;
  }
  .heading.toggle:hover .eyebrow {
    color: var(--fg-dim);
  }
  .chev {
    display: grid;
    transition: transform var(--t) var(--ease);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 30px;
    padding: 0 10px 0 12px;
    border-radius: 7px;
    color: var(--fg-dim);
    font-size: 13px;
    text-align: left;
    transition:
      background var(--t) var(--ease),
      color var(--t) var(--ease);
  }
  .item:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .item.active {
    background: var(--active);
    color: var(--fg-bright);
  }
  .item.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2.5px;
    border-radius: 2px;
    background: var(--accent);
  }
  .item.active :global(svg) {
    color: var(--accent);
  }
  .item.today :global(svg) {
    color: var(--accent);
    opacity: 0.85;
  }
  .item.dim {
    opacity: 0.55;
  }
  .item.dim:hover,
  .item.dim.active {
    opacity: 1;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--muted);
  }
  .count.strong {
    color: var(--accent);
    font-weight: 600;
  }
  .cat {
    width: 8px;
    height: 8px;
    margin: 0 3px;
    border-radius: 3px;
    flex: none;
  }
  .setup {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 2px 4px;
    padding: 10px 12px;
    border-radius: 9px;
    text-align: left;
    font-size: 12px;
    line-height: 1.45;
    color: var(--fg-dim);
    background: linear-gradient(135deg, var(--accent-soft), transparent 80%);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 20%, transparent);
  }
  .setup em {
    font-style: normal;
    color: var(--fg);
  }
  .setup .link {
    color: var(--accent);
    font-weight: 600;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 8px 8px 14px;
    border-top: 1px solid var(--line);
  }
  .sync {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--green) 20%, transparent);
  }
  .pulse.busy {
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .pulse.err {
    background: var(--red);
  }
  @keyframes pulse {
    50% {
      box-shadow: 0 0 0 5px color-mix(in oklab, var(--accent) 5%, transparent);
    }
  }
  .small {
    width: 26px;
    height: 26px;
  }
  .keys {
    padding: 4px;
  }
</style>
