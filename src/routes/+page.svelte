<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "$lib/state/app.svelte";
  import { handleKey } from "$lib/keys";
  import TopBar from "$lib/components/TopBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import MessageList from "$lib/components/MessageList.svelte";
  import Reader from "$lib/components/Reader.svelte";
  import Today from "$lib/components/Today.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import AgentPanel from "$lib/components/AgentPanel.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import SettingsModal from "$lib/components/SettingsModal.svelte";
  import Cheatsheet from "$lib/components/Cheatsheet.svelte";
  import Onboarding from "$lib/components/Onboarding.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import Logo from "$lib/components/Logo.svelte";

  const LIST_KEY = "tern.listWidth";
  let listWidth = $state(420);
  try {
    listWidth = Number(localStorage.getItem(LIST_KEY)) || 420;
  } catch {}

  onMount(() => {
    app.init();
    return () => app.destroy();
  });

  $effect(() => {
    document.documentElement.dataset.density = app.settings?.ui.density ?? "comfortable";
  });

  function startResize(e: PointerEvent) {
    const startX = e.clientX;
    const start = listWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      listWidth = Math.max(300, Math.min(720, start + ev.clientX - startX));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(LIST_KEY, String(listWidth));
      } catch {}
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if !app.ready}
  <div class="splash" data-tauri-drag-region><div class="pulse"><Logo size={40} /></div></div>
{:else if app.bootError}
  <div class="splash" data-tauri-drag-region>
    <div class="boot-err">
      <Logo size={32} />
      <h2>Tern couldn't start</h2>
      <pre>{app.bootError}</pre>
      <button class="btn" onclick={() => location.reload()}>Retry</button>
    </div>
  </div>
{:else if !app.hasAccounts || app.onboarding}
  <Onboarding />
{:else}
  <div class="app">
    <TopBar />
    <main style:--list-w="{listWidth}px" class:today={app.view.kind === "today"}>
      <Sidebar />
      {#if app.view.kind === "today"}
        <Today />
      {:else}
        <MessageList />
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="resizer" onpointerdown={startResize}></div>
        <Reader />
      {/if}
    </main>
  </div>
  <AgentPanel />
  <Composer />
  <CommandPalette />
  <Cheatsheet />
{/if}

{#if app.ready}
  <SettingsModal />
{/if}
<Toasts />

<style>
  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  main {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 236px var(--list-w) 0 minmax(0, 1fr);
  }
  main.today {
    grid-template-columns: 236px minmax(0, 1fr);
  }
  .resizer {
    position: relative;
    width: 0;
    z-index: 2;
  }
  .resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 6px;
    cursor: col-resize;
  }
  .resizer:hover::after {
    background: linear-gradient(90deg, transparent 2px, var(--accent-line) 2px, var(--accent-line) 4px, transparent 4px);
  }
  @media (max-width: 1100px) {
    main {
      grid-template-columns: 210px minmax(280px, 360px) 0 minmax(0, 1fr);
    }
    main.today {
      grid-template-columns: 210px minmax(0, 1fr);
    }
  }
  @media (max-width: 820px) {
    main {
      grid-template-columns: 0 minmax(260px, 1fr) 0 minmax(0, 1.4fr);
    }
    main :global(.sidebar) {
      display: none;
    }
  }
  .splash {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--surface);
  }
  .pulse {
    animation: breathe 1.6s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.45;
      transform: scale(0.96);
    }
  }
  .boot-err {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    max-width: 560px;
    text-align: center;
  }
  .boot-err h2 {
    margin: 0;
    font-size: 17px;
  }
  .boot-err pre {
    white-space: pre-wrap;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--red);
    user-select: text;
  }
</style>
