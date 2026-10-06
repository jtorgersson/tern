<script lang="ts">
  import { toasts } from "$lib/state/toasts.svelte";
  import { CircleCheck, CircleAlert, Info, LoaderCircle, X } from "@lucide/svelte";
</script>

<div class="toasts" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <div class="toast {t.kind}">
      <span class="ic">
        {#if t.kind === "success"}<CircleCheck size={15} />
        {:else if t.kind === "error"}<CircleAlert size={15} />
        {:else if t.kind === "progress"}<LoaderCircle size={15} class="spin" />
        {:else}<Info size={15} />{/if}
      </span>
      <span class="text">{t.text}</span>
      {#if t.action}
        <button class="act" onclick={() => { t.action!.run(); toasts.dismiss(t.id); }}>{t.action.label}</button>
      {/if}
      <button class="x" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}><X size={13} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    z-index: 100;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 260px;
    max-width: 560px;
    padding: 9px 10px 9px 13px;
    border-radius: var(--r);
    background: color-mix(in oklab, var(--bg-lighter) 92%, black);
    box-shadow: var(--shadow);
    font-size: 12.5px;
    animation: fade-up 180ms var(--ease);
  }
  .ic {
    display: grid;
    color: var(--accent);
  }
  .success .ic {
    color: var(--green);
  }
  .error .ic {
    color: var(--red);
  }
  .text {
    flex: 1;
    user-select: text;
  }
  .act {
    font-weight: 600;
    color: var(--accent);
    padding: 3px 8px;
    border-radius: 5px;
  }
  .act:hover {
    background: var(--accent-soft);
  }
  .x {
    display: grid;
    color: var(--muted);
    padding: 3px;
    border-radius: 4px;
  }
  .x:hover {
    color: var(--fg);
    background: var(--hover);
  }
</style>
