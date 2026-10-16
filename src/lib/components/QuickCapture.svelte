<script lang="ts">
  import { emit } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { api } from "$lib/api";
  import { applyTheme } from "$lib/theme";
  import { notes } from "$lib/state/notes.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { errMsg } from "$lib/util/misc";
  import { onMount, tick } from "svelte";

  let { mode = "window" }: { mode?: "window" | "overlay" } = $props();

  let text = $state("");
  let input = $state<HTMLTextAreaElement | undefined>();
  let saving = $state(false);
  let ready = $state(false);

  onMount(() => {
    if (mode === "overlay") ready = true;
    else {
      api
        .theme()
        .then((theme) => applyTheme(theme, { translucent: true, contrast: "higher" }))
        .catch(() => {})
        .finally(() => (ready = true));
    }
    tick().then(() => input?.focus());
  });

  async function close() {
    if (mode === "window") {
      await getCurrentWindow().close().catch(() => {});
    } else {
      notes.captureOpen = false;
    }
  }

  async function save() {
    const body = text.trim();
    if (!body || saving) {
      if (!body) input?.focus();
      return;
    }
    saving = true;
    try {
      if (mode === "overlay") {
        await notes.create(body);
      } else {
        await api.notesCreate({ body, source: "capture" });
        await emit("notes://changed", {});
        await getCurrentWindow().close().catch(() => {});
      }
    } catch (e) {
      saving = false;
      toasts.error(errMsg(e));
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
</script>

<div class="cap" class:overlay={mode === "overlay"} data-tauri-drag-region>
  {#if ready}
    <form class="card" data-tauri-drag-region onsubmit={(e) => { e.preventDefault(); save(); }}>
      <div class="top" data-tauri-drag-region>
        <span class="mark"></span>
        <span class="label">New note</span>
        <button type="button" class="icon-btn s" aria-label="Close" onclick={close}>✕</button>
      </div>
      <textarea
        bind:this={input}
        bind:value={text}
        rows="5"
        placeholder="Write it down. The first line becomes the title."
        onkeydown={onKey}
        disabled={saving}></textarea>
      <div class="foot">
        <span><kbd>Enter</kbd> save · <kbd>Shift Enter</kbd> new line · <kbd>Super N</kbd> anywhere</span>
        <button class="btn primary sm" type="submit" disabled={saving || !text.trim()}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </form>
  {/if}
</div>

<style>
  .cap {
    height: 100%;
    display: grid;
    place-items: center;
    padding: 18px;
    background: transparent;
  }
  .cap.overlay {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: color-mix(in oklab, var(--bg-darker) 55%, transparent);
    height: auto;
  }
  .card {
    width: min(520px, 100%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 14px 12px;
    border-radius: 16px;
    background: color-mix(in oklab, var(--bg) 92%, transparent);
    box-shadow: var(--shadow);
    backdrop-filter: blur(18px);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mark {
    width: 8px;
    height: 8px;
    border-radius: 99px;
    background: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .label {
    flex: 1;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  textarea {
    width: 100%;
    resize: none;
    border: 0;
    outline: none;
    background: transparent;
    min-height: 140px;
    font-size: 18px;
    line-height: 1.45;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
    user-select: text;
    -webkit-user-select: text;
  }
  textarea::placeholder { color: var(--muted); }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--muted);
    font-size: 11.5px;
  }
  .icon-btn.s { width: 26px; height: 26px; }
</style>
