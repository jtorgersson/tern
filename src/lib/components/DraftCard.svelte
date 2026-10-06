<script lang="ts">
  // "Tern drafted a reply" — shown on Today cards and above the reader's quick-reply bar.
  import { today } from "$lib/state/today.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { app } from "$lib/state/app.svelte";
  import { api } from "$lib/api";
  import { textToHtml } from "$lib/util/misc";
  import type { MessageFull, MessageSummary } from "$lib/types";
  import { Sparkles, ArrowUp, ChevronDown, PenLine, Check, LoaderCircle, X } from "@lucide/svelte";
  import { tick } from "svelte";

  let {
    message,
    compact = false,
    onused,
  }: { message: MessageSummary | MessageFull; compact?: boolean; onused?: () => void } = $props();

  const text = $derived(message.ai?.suggestedReply ?? null);
  const drafting = $derived(today.drafting.has(message.id));
  let expanded = $state(false);
  let tweaking = $state(false);
  let instruction = $state("");
  let input: HTMLInputElement | undefined = $state();

  const long = $derived((text?.split("\n").length ?? 0) > 4 || (text?.length ?? 0) > 320);

  async function full(): Promise<MessageFull> {
    if ("bodyHtml" in message) return message;
    return api.message(message.id);
  }

  async function use(mode: "reply" | "replyAll" = "reply") {
    if (!text) return;
    const m = await full();
    composer.reply(m, mode, textToHtml(text));
    onused?.();
  }

  async function edit() {
    await use();
  }

  function startTweak() {
    tweaking = true;
    tick().then(() => input?.focus());
  }

  async function tweak(e: Event) {
    e.preventDefault();
    const ins = instruction.trim();
    if (!ins) return;
    tweaking = false;
    instruction = "";
    expanded = true;
    await today.draftFor(message.id, ins);
  }
</script>

<div class="draft" class:compact class:has={!!text}>
  <div class="head">
    <span class="spark"><Sparkles size={12} /></span>
    <span class="eyebrow">{drafting ? (text ? "Redrafting" : "Drafting") : text ? "Tern drafted a reply" : "Reply"}</span>
    <span class="spacer"></span>
    {#if drafting}
      <LoaderCircle size={12} class="spin" />
    {:else if text && long}
      <button class="mini" onclick={() => (expanded = !expanded)}>
        <span class="chev" class:open={expanded}><ChevronDown size={12} /></span>{expanded ? "Less" : "Show more"}
      </button>
    {/if}
  </div>

  {#if drafting && !text}
    <div class="skeleton">
      <span style:width="92%"></span><span style:width="78%"></span><span style:width="60%"></span>
    </div>
  {:else if text}
    <div class="text" class:clamp={long && !expanded}>{text}</div>
    {#if tweaking}
      <form class="tweak" onsubmit={tweak}>
        <PenLine size={13} />
        <input bind:this={input} bind:value={instruction} placeholder="How should it change? e.g. “shorter, and say yes to Thursday”" onkeydown={(e) => e.key === "Escape" && (tweaking = false)} />
        <button class="go" disabled={!instruction.trim()} aria-label="Redraft"><ArrowUp size={13} /></button>
        <button type="button" class="icon-btn s" aria-label="Cancel" onclick={() => (tweaking = false)}><X size={13} /></button>
      </form>
    {:else}
      <div class="actions">
        <button class="btn primary sm" onclick={() => use()}><Check size={13} /> Use draft</button>
        <button class="btn sm" onclick={edit}>Edit</button>
        <button class="btn sm ghost" onclick={startTweak}><PenLine size={13} /> Different angle…</button>
      </div>
    {/if}
  {:else}
    <div class="actions">
      <button class="btn sm" onclick={() => today.draftFor(message.id, "Write an appropriate, helpful reply.")} disabled={!app.aiReady}>
        <Sparkles size={13} /> Draft reply
      </button>
    </div>
  {/if}
</div>

<style>
  .draft {
    padding: 12px 14px;
    border-radius: 12px;
    background:
      linear-gradient(135deg, color-mix(in oklab, var(--accent) 9%, transparent), transparent 65%),
      color-mix(in oklab, var(--bg-lighter) 40%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 18%, var(--line));
    animation: fade-up 180ms var(--ease);
  }
  .draft.compact {
    padding: 10px 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--accent);
  }
  .head .eyebrow {
    color: var(--accent);
  }
  .spark {
    display: grid;
  }
  .spacer {
    flex: 1;
  }
  .mini {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    color: var(--fg-dim);
    padding: 2px 7px;
    border-radius: 6px;
  }
  .mini:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .chev {
    display: grid;
    transition: transform var(--t) var(--ease);
  }
  .chev.open {
    transform: rotate(180deg);
  }
  .text {
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--fg);
    white-space: pre-wrap;
    user-select: text;
  }
  .text.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 10px;
  }
  .skeleton span {
    height: 10px;
    border-radius: 5px;
    background: linear-gradient(90deg, var(--hover) 25%, color-mix(in oklab, var(--accent) 14%, transparent) 50%, var(--hover) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }
  .tweak {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    height: 34px;
    padding: 0 4px 0 10px;
    border-radius: 9px;
    color: var(--accent);
    background: color-mix(in oklab, var(--bg-darker) 55%, transparent);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .tweak input {
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    font-size: 12.5px;
    color: var(--fg);
    user-select: text;
  }
  .tweak input::placeholder {
    color: color-mix(in oklab, var(--fg) 38%, transparent);
  }
  .go {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--accent);
    color: var(--on-accent);
  }
  .go:disabled {
    opacity: 0.3;
  }
  .icon-btn.s {
    width: 26px;
    height: 26px;
  }
  @media (prefers-reduced-motion: reduce) {
    .draft,
    .skeleton span {
      animation: none;
    }
  }
</style>
