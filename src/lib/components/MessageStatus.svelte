<script lang="ts">
  import { Reply, Forward } from "@lucide/svelte";
  import type { MessageSummary } from "$lib/types";
  let { message, compact = false }: { message: MessageSummary; compact?: boolean } = $props();
</script>

{#if message.isReplied || message.isForwarded}
  <span class="status" class:compact>
    {#if message.isReplied}<span title="You replied to this email" aria-label="Replied"><Reply size={13} />{#if !compact}Replied{/if}</span>{/if}
    {#if message.isForwarded}<span title="You forwarded this email" aria-label="Forwarded"><Forward size={13} />{#if !compact}Forwarded{/if}</span>{/if}
  </span>
{/if}

<style>
  .status, .status > span { display: inline-flex; align-items: center; gap: 5px; }
  .status { color: var(--muted); font-size: 11px; gap: 10px; flex: none; }
  .status.compact { color: var(--accent); gap: 3px; }
</style>
