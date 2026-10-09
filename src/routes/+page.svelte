<script lang="ts">
  import { onMount } from "svelte";
  import GlobalSearch from "$lib/components/GlobalSearch.svelte";
  import Connect from "$lib/components/Connect.svelte";
  import { connect } from "$lib/state/connect.svelte";
  import { app } from "$lib/state/app.svelte";
  import { handleKey } from "$lib/keys";
  import TopBar from "$lib/components/TopBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import MessageList from "$lib/components/MessageList.svelte";
  import Reader from "$lib/components/Reader.svelte";
  import Today from "$lib/components/Today.svelte";
  import Calendar from "$lib/components/Calendar.svelte";
  import EventComposer from "$lib/components/EventComposer.svelte";
  import EventDetails from "$lib/components/EventDetails.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import AgentPanel from "$lib/components/AgentPanel.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import SettingsModal from "$lib/components/SettingsModal.svelte";
  import Cheatsheet from "$lib/components/Cheatsheet.svelte";
  import SnoozePicker from "$lib/components/SnoozePicker.svelte";
  import Onboarding from "$lib/components/Onboarding.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import Logo from "$lib/components/Logo.svelte";
  import MessageWindow from "$lib/components/MessageWindow.svelte";
  import { messageWindowId } from "$lib/util/windows";

  /** Set when this webview is a pop-out window for one message. */
  const popupId = messageWindowId();

  const LIST_KEY = "tern.listWidth";
  let listWidth = $state(420);
  try {
    listWidth = Number(localStorage.getItem(LIST_KEY)) || 420;
  } catch {}

  onMount(() => {
    if (popupId) app.initMessageWindow(popupId);
    else app.init();
    return () => app.destroy();
  });

  $effect(() => {
    document.documentElement.dataset.density = app.settings?.ui.density ?? "comfortable";
  });

  function resizeConnect(e: PointerEvent) {
    const startX = e.clientX;
    const width = connect.width;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => connect.width = Math.max(360, Math.min(900, width + startX - ev.clientX));
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      connect.saveWidth();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

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
{:else if popupId}
  <MessageWindow />
{:else if !app.hasAccounts || app.onboarding}
  <Onboarding />
{:else}
  <div class="app">
    <TopBar />
    <div class="workspace-row" class:docked={connect.open} class:expanded={connect.open && connect.expanded}>
      <main style:--list-w="{listWidth}px" class:today={app.isCanvasView} class:no-pane={!app.isCanvasView && !app.readingPane} class:has-message={!!app.open || app.openLoading}>
        <Sidebar />
        {#if app.view.kind === "today"}
          <Today />
        {:else if app.view.kind === "calendar"}
          <Calendar />
        {:else}
          <MessageList />
          {#if app.readingPane}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="resizer" onpointerdown={startResize}></div>
            <Reader />
          {/if}
        {/if}
      </main>
      <aside class="connect-dock" hidden={!connect.open} style:width="{connect.width}px">
        {#if !connect.expanded}
          <!-- ARIA window splitter: focusable separator supports arrow-key resizing. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div class="dock-resizer" role="separator" aria-label="Resize Connect" aria-orientation="vertical" aria-valuenow={connect.width} aria-valuemin={360} aria-valuemax={900} tabindex="0" onpointerdown={resizeConnect}
            onkeydown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); connect.width = Math.max(360, Math.min(900, connect.width + (e.key === "ArrowLeft" ? 30 : -30))); connect.saveWidth(); } }}></div>
        {/if}
        <Connect />
      </aside>
    </div>
  </div>
  <GlobalSearch />
  <AgentPanel />
  <Composer />
  <EventComposer />
  <EventDetails />
  <CommandPalette />
  <Cheatsheet />
  <SnoozePicker />
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
  .workspace-row { flex: 1; min-height: 0; display: flex; overflow-x: auto; }
  .docked main { min-width: 700px; }
  .workspace-row.expanded main { display: none; }
  .connect-dock { position: relative; flex: none; min-width: 360px; }
  .connect-dock[hidden] { display: none; }
  .expanded .connect-dock { flex: 1; }
  .dock-resizer { position: absolute; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; z-index: 3; touch-action: none; }
  .dock-resizer:hover, .dock-resizer:focus-visible { background: var(--accent-line); }
  main {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: grid;
    grid-template-columns: 236px var(--list-w) 0 minmax(0, 1fr);
  }
  main.today,
  main.no-pane {
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
    main { grid-template-columns: 210px minmax(280px, 360px) 0 minmax(0, 1fr); }
    main.today, main.no-pane { grid-template-columns: 210px minmax(0, 1fr); }
  }
  @media (max-width: 1500px) {
    .docked main { min-width: 600px; grid-template-columns: minmax(280px, .8fr) 0 minmax(320px, 1fr); }
    .docked main.today, .docked main.no-pane { min-width: 340px; grid-template-columns: minmax(0, 1fr); }
    .docked main :global(.sidebar) { display: none; }
    .docked:not(.expanded) .connect-dock { max-width: 45vw; }
  }
  @media (max-width: 1100px) {
    .docked main { min-width: 340px; grid-template-columns: minmax(0, 1fr); }
    .docked main .resizer { display: none; }
    .docked main.has-message:not(.no-pane) :global(.list) { display: none; }
    .docked main:not(.has-message) :global(.reader) { display: none; }
    .docked main :global(.back-list) { display: inline-flex; }
  }
  @media (max-width: 820px) {
    main { grid-template-columns: minmax(0, 1fr); }
    main.today, main.no-pane { grid-template-columns: minmax(0, 1fr); }
    main :global(.sidebar) { display: none; }
    main .resizer { display: none; }
    main.has-message:not(.no-pane) :global(.list) { display: none; }
    main:not(.has-message) :global(.reader) { display: none; }
    main :global(.back-list) { display: inline-flex; }
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
