<script lang="ts">
  import { app, CATEGORY_META } from "$lib/state/app.svelte";
  import { summarizeThread } from "$lib/ai";
  import { readerBus } from "$lib/keys";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { errMsg } from "$lib/util/misc";
  import type { MessageFull } from "$lib/types";
  import { Sparkles, LoaderCircle, RotateCcw, CircleCheck } from "@lucide/svelte";

  let { thread, message }: { thread: MessageFull[]; message: MessageFull } = $props();

  let text = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let ctrl: AbortController | null = null;

  const note = $derived(message.ai);
  const cat = $derived(note ? CATEGORY_META[note.category] : null);

  async function run() {
    if (!app.aiReady || busy) return;
    ctrl?.abort();
    ctrl = new AbortController();
    const mine = ctrl;
    busy = true;
    error = null;
    text = "";
    try {
      for await (const d of summarizeThread(thread.length ? thread : [message], mine.signal)) {
        if (mine.signal.aborted) break;
        text += d;
      }
    } catch (e) {
      if (!mine.signal.aborted) error = errMsg(e);
    } finally {
      if (ctrl === mine) busy = false;
    }
  }

  // Auto-summarize long threads once.
  let autoFor = "";
  $effect(() => {
    const key = message.id + ":" + thread.length;
    if (app.aiReady && thread.length >= 3 && autoFor !== key && !text) {
      autoFor = key;
      run();
    }
  });

  $effect(() => {
    const h = () => run();
    readerBus.addEventListener("summarize", h);
    return () => {
      readerBus.removeEventListener("summarize", h);
      ctrl?.abort();
    };
  });
</script>

{#if note || text || busy || error || app.aiReady}
  <div class="tldr" class:active={busy || text}>
    <div class="head">
      <span class="spark"><Sparkles size={13} /></span>
      <span class="eyebrow">{text || busy ? "Thread summary" : "Tern"}</span>
      {#if cat && note}
        <span class="chip" style:color={cat.color} style:background="color-mix(in oklab, {cat.color} 14%, transparent)">{cat.label}</span>
        {#if note.priority === 3}<span class="chip prio">High priority</span>{/if}
        {#if note.dueAt}<span class="chip due">Due {new Date(note.dueAt).toLocaleDateString([], { day: "numeric", month: "short" })}</span>{/if}
      {/if}
      <span class="spacer"></span>
      {#if busy}
        <LoaderCircle size={13} class="spin" />
      {:else if app.aiReady}
        <button class="mini" onclick={run} title="Summarize thread (t)">
          {#if text}<RotateCcw size={12} /> Again{:else}Summarize{#if thread.length > 1} thread{/if} <kbd>t</kbd>{/if}
        </button>
      {/if}
    </div>

    {#if text}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="md body" onclick={mdLinkHandler}>{@html md(text)}</div>
    {:else if busy}
      <div class="body shimmer-text">Reading {thread.length > 1 ? `${thread.length} messages` : "the message"}…</div>
    {:else if note}
      <div class="body summary">{note.summary}</div>
      {#if note.actionItems.length}
        <ul class="actions">
          {#each note.actionItems as item}
            <li><CircleCheck size={13} /> <span>{item}</span></li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if error}<div class="err">{error}</div>{/if}
  </div>
{/if}

<style>
  .tldr {
    position: relative;
    margin: 0 0 18px;
    padding: 12px 14px;
    border-radius: var(--r-lg);
    background:
      linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, transparent), transparent 60%),
      color-mix(in oklab, var(--bg-lighter) 45%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 16%, var(--line));
    animation: fade-up 200ms var(--ease);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    flex-wrap: wrap;
  }
  .spark {
    display: grid;
  }
  .head .eyebrow {
    color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .mini {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 560;
    color: var(--fg-dim);
    padding: 3px 8px;
    border-radius: 6px;
  }
  .mini:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .mini kbd {
    font-size: 9.5px;
    padding: 0 4px;
  }
  .body {
    margin-top: 8px;
    font-size: 13px;
    color: var(--fg);
    user-select: text;
  }
  .summary {
    color: var(--fg);
  }
  .actions {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    color: var(--fg-dim);
  }
  .actions li {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .actions :global(svg) {
    margin-top: 2px;
    color: var(--accent);
    flex: none;
  }
  .chip.prio {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 14%, transparent);
  }
  .chip.due {
    color: var(--yellow);
    background: color-mix(in oklab, var(--yellow) 14%, transparent);
  }
  .err {
    margin-top: 6px;
    font-size: 12px;
    color: var(--red);
  }
</style>
