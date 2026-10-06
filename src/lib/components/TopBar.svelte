<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { Search, PenLine, Sparkles, Settings, RefreshCw, X } from "@lucide/svelte";
  import Logo from "./Logo.svelte";
  import NextUp from "./NextUp.svelte";

  let q = $state("");
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (app.searchFocusTick) {
      input?.focus();
      input?.select();
    }
  });

  // Mirror the active search view into the box.
  $effect(() => {
    if (app.view.kind === "search") q = app.view.query;
  });

  function submit(e: Event) {
    e.preventDefault();
    app.search(q);
  }
  function clear() {
    q = "";
    app.search("");
  }
</script>

<header class="bar" data-tauri-drag-region>
  <div class="brand" data-tauri-drag-region>
    <Logo size={19} />
    <span class="word" data-tauri-drag-region>tern</span>
  </div>

  <form class="search" onsubmit={submit} role="search">
    <Search size={14} />
    <input
      bind:this={input}
      bind:value={q}
      placeholder="Search mail — from:, subject:, has:attachment"
      spellcheck="false"
      onkeydown={(e) => {
        if (e.key === "Escape" && q) {
          e.stopPropagation();
          clear();
        }
      }} />
    {#if q}
      <button type="button" class="clear" onclick={clear} aria-label="Clear search"><X size={13} /></button>
    {:else}
      <kbd>/</kbd>
    {/if}
  </form>

  <div class="right" data-tauri-drag-region>
    <NextUp />
    {#if app.triaging}
      <span class="status shimmer-text" title="AI is sorting new mail">Triaging…</span>
    {/if}
    <button
      class="icon-btn"
      title="Sync now (Ctrl R)"
      aria-label="Sync now"
      onclick={() => app.syncNow()}>
      <RefreshCw size={15} class={app.isSyncing ? "spin" : ""} />
    </button>
    <button class="icon-btn" title="Compose (c)" aria-label="Compose" onclick={() => composer.compose()}>
      <PenLine size={15} />
    </button>
    <button
      class="ask"
      class:on={app.agentOpen}
      title="Ask Tern (Ctrl J)"
      onclick={() => app.toggleAgent()}>
      <Sparkles size={14} />
      <span>Ask Tern</span>
      <kbd>^J</kbd>
    </button>
    <button class="icon-btn" title="Settings (Ctrl ,)" aria-label="Settings" onclick={() => app.openSettings()}>
      <Settings size={15} />
    </button>
  </div>
</header>

<style>
  .bar {
    height: 46px;
    flex: none;
    display: grid;
    grid-template-columns: 1fr minmax(280px, 560px) 1fr;
    align-items: center;
    gap: 16px;
    padding: 0 10px 0 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .word {
    font-weight: 680;
    font-size: 15px;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px 0 11px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--fg) 5%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--muted);
    transition:
      box-shadow var(--t),
      background var(--t);
  }
  .search:focus-within {
    background: color-mix(in oklab, var(--bg-darker) 60%, transparent);
    box-shadow:
      inset 0 0 0 1px var(--accent-line),
      0 0 0 3px var(--accent-soft);
    color: var(--accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: none;
    color: var(--fg);
    font-size: 12.5px;
  }
  .search input::placeholder {
    color: color-mix(in oklab, var(--fg) 35%, transparent);
  }
  .clear {
    display: grid;
    color: var(--muted);
  }
  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
  }
  .status {
    font-size: 11.5px;
    font-weight: 550;
    margin-right: 8px;
  }
  .ask {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 8px 0 10px;
    margin: 0 4px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 560;
    color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 28%, transparent);
    transition: all var(--t) var(--ease);
  }
  .ask:hover,
  .ask.on {
    background: color-mix(in oklab, var(--accent) 26%, transparent);
  }
  .ask kbd {
    border-color: color-mix(in oklab, var(--accent) 30%, transparent);
    color: color-mix(in oklab, var(--accent) 80%, var(--fg));
    background: transparent;
  }
</style>
