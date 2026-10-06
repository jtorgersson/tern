<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { SHORTCUTS } from "$lib/keys";

  const groups = ["Navigate", "Act", "Compose", "AI", "App"] as const;
</script>

{#if app.cheatsheetOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => (app.cheatsheetOpen = false)}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      <h2>Keyboard</h2>
      <div class="cols">
        {#each groups as g}
          <div class="col">
            <div class="eyebrow">{g}</div>
            {#each SHORTCUTS.filter((s) => s.group === g) as s}
              <div class="row">
                <span>{s.label}</span>
                <span class="keys">
                  {#each s.keys.split(" ") as k}
                    {#if k === "/"}<span class="sep">/</span>{:else}<kbd>{k}</kbd>{/if}
                  {/each}
                </span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--bg-darker) 55%, transparent);
  }
  .sheet {
    width: min(860px, calc(100vw - 40px));
    max-height: calc(100vh - 80px);
    overflow: auto;
    padding: 26px 30px;
    border-radius: 18px;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: var(--shadow);
    animation: fade-up 180ms var(--ease);
  }
  h2 {
    margin: 0 0 18px;
    font-size: 17px;
    font-weight: 680;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 22px 30px;
  }
  .col .eyebrow {
    margin-bottom: 8px;
    color: var(--accent);
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    font-size: 12.5px;
    color: var(--fg-dim);
  }
  .keys {
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .sep {
    color: var(--muted);
    font-size: 11px;
  }
</style>
