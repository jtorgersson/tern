<script lang="ts">
  // Move to folder (v): a fuzzy picker over the message's own folders. Undo lives in the toast afterwards.
  import { app, wkLabel } from "$lib/state/app.svelte";
  import { fuzzyScore } from "$lib/util/fuzzy";
  import type { Folder, WellKnownFolder } from "$lib/types";
  import { tick } from "svelte";
  import { FolderInput, Inbox, Archive, ShieldAlert, Trash2, Folder as FolderIcon, CornerDownLeft } from "@lucide/svelte";

  interface Choice {
    id: string;
    label: string;
    /** "Parent / Child" for nested folders, shown dimmed. */
    path: string;
    icon: typeof Inbox;
    destination: string;
  }

  const WK: { wk: WellKnownFolder; icon: typeof Inbox }[] = [
    { wk: "inbox", icon: Inbox },
    { wk: "archive", icon: Archive },
    { wk: "junkemail", icon: ShieldAlert },
    { wk: "deleteditems", icon: Trash2 },
  ];

  let q = $state("");
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();

  const ids = $derived(app.moveTarget ?? []);
  /** Messages being moved: from the loaded list, else the open one. */
  const targets = $derived(ids.map((id) => app.messages.find((m) => m.id === id) ?? (app.open?.id === id ? app.open : null)).filter((m) => !!m));
  const accountIds = $derived(new Set(targets.map((m) => m.accountId)));
  const currentFolders = $derived(new Set(targets.map((m) => m.folderId)));

  $effect(() => {
    if (app.moveTarget) {
      q = "";
      active = 0;
      tick().then(() => input?.focus());
    }
  });

  const choices = $derived.by<Choice[]>(() => {
    const out: Choice[] = [];
    const single = accountIds.size === 1 ? [...accountIds][0] : null;
    for (const { wk, icon } of WK) {
      // Skip the folder the message already sits in (when all targets share it).
      const f = single ? app.folderFor(single, wk) : undefined;
      if (f && currentFolders.size === 1 && currentFolders.has(f.id)) continue;
      out.push({ id: `wk-${wk}`, label: wkLabel(wk), path: "", icon, destination: wk });
    }
    if (!single) return out;
    const custom = app.folders.filter((f) => f.accountId === single && !f.wellKnown);
    const byId = new Map(custom.map((f) => [f.id, f]));
    const pathOf = (f: Folder): string => {
      const parts: string[] = [];
      let cur: Folder | undefined = f;
      let guard = 0;
      while (cur && guard++ < 12) {
        parts.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return parts.join(" / ");
    };
    for (const f of custom.sort((a, b) => pathOf(a).localeCompare(pathOf(b)))) {
      if (currentFolders.size === 1 && currentFolders.has(f.id)) continue;
      const path = pathOf(f);
      out.push({ id: f.id, label: f.name, path: path === f.name ? "" : path.slice(0, -f.name.length - 3), icon: FolderIcon, destination: f.id });
    }
    return out;
  });

  const results = $derived.by(() => {
    const query = q.trim();
    if (!query) return choices;
    return choices
      .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.label), fuzzyScore(query, `${c.path} ${c.label}`) - 5) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  });

  $effect(() => {
    void q;
    active = 0;
  });

  function close() {
    app.moveTarget = null;
  }

  function pick(c: Choice | undefined) {
    if (!c || !ids.length) return;
    const n = ids.length;
    const label = n > 1 ? `Moved ${n} messages to ${c.label}` : `Moved to ${c.label}`;
    close();
    void app.moveTo(ids, c.destination, label);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      scrollActive();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      active = Math.max(0, active - 1);
      scrollActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function scrollActive() {
    tick().then(() => listEl?.querySelector(".active")?.scrollIntoView({ block: "nearest" }));
  }
</script>

{#if app.moveTarget}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close}>
    <div class="picker" role="dialog" aria-label="Move to folder" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <div class="in">
        <FolderInput size={16} />
        <input bind:this={input} bind:value={q} {onkeydown} placeholder={ids.length > 1 ? `Move ${ids.length} messages to…` : "Move to…"} spellcheck="false" />
        <kbd>esc</kbd>
      </div>
      <div class="results" bind:this={listEl}>
        {#each results as c, i (c.id)}
          <button class="item" class:active={i === active} onmousemove={() => (active = i)} onclick={() => pick(c)}>
            <c.icon size={14} />
            <span class="label">{#if c.path}<span class="path">{c.path} / </span>{/if}{c.label}</span>
            {#if i === active}<CornerDownLeft size={13} class="enter" />{/if}
          </button>
        {:else}
          <div class="none">{accountIds.size > 1 ? "Messages from several accounts: only the standard folders are available" : "No folder matches"}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 14vh;
    background: color-mix(in oklab, var(--bg-darker) 45%, transparent);
    animation: fade 120ms;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .picker {
    width: min(460px, calc(100vw - 40px));
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 60%, var(--bg));
    box-shadow: var(--shadow);
    overflow: hidden;
    animation: pop 160ms var(--ease);
  }
  @keyframes pop {
    from {
      transform: scale(0.98) translateY(-6px);
      opacity: 0;
    }
  }
  .in {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 14px 0 16px;
    border-bottom: 1px solid var(--line);
    color: var(--accent);
  }
  .in input {
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    font-size: 14px;
    color: var(--fg);
  }
  .in input::placeholder {
    color: var(--muted);
  }
  .results {
    max-height: min(380px, 56vh);
    overflow-y: auto;
    padding: 6px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 34px;
    padding: 0 12px;
    border-radius: 8px;
    text-align: left;
    font-size: 13px;
    color: var(--fg-dim);
  }
  .item :global(svg:first-child) {
    color: var(--muted);
    flex: none;
  }
  .item.active {
    background: var(--active);
    color: var(--fg-bright);
  }
  .item.active :global(svg:first-child) {
    color: var(--accent);
  }
  .label {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .path {
    color: var(--muted);
  }
  .item :global(.enter) {
    color: var(--accent);
  }
  .none {
    padding: 18px;
    text-align: center;
    font-size: 12.5px;
    color: var(--muted);
  }
</style>
