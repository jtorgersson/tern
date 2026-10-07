<script lang="ts">
  // A message in its own window (opened from the list with O / double-click, or with Enter when the reading pane is hidden).
  import { app } from "$lib/state/app.svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { X } from "@lucide/svelte";
  import Reader from "./Reader.svelte";
  import Composer from "./Composer.svelte";
  import SnoozePicker from "./SnoozePicker.svelte";

  let shown = $state(false);

  $effect(() => {
    if (app.open) {
      shown = true;
      getCurrentWindow().setTitle(app.open.subject || "(no subject)").catch(() => {});
    } else if (shown && !app.openLoading) {
      // Archived, deleted or snoozed from here: the window has done its job.
      getCurrentWindow().close();
    }
  });
</script>

<div class="win">
  {#if app.open || app.openLoading}
    <Reader />
  {:else}
    <div class="gone" data-tauri-drag-region>
      <p>This message is no longer available — it may have been moved or deleted.</p>
      <button class="btn" onclick={() => getCurrentWindow().close()}><X size={14} /> Close</button>
    </div>
  {/if}
</div>
<Composer />
<SnoozePicker />

<style>
  .win {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .win > :global(.reader) {
    flex: 1;
  }
  .gone {
    flex: 1;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    color: var(--fg-dim);
    padding: 24px;
    text-align: center;
  }
</style>
