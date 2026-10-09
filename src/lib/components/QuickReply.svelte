<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { draftReply } from "$lib/ai";
  import type { MessageFull } from "$lib/types";
  import { Sparkles, Reply, ReplyAll, Forward, ArrowUp } from "@lucide/svelte";
  import DraftCard from "./DraftCard.svelte";

  let { message, thread }: { message: MessageFull; thread: MessageFull[] } = $props();
  let instruction = $state("");
  let aiOpen = $state(false);

  const CHIPS = [
    { label: "Accept", text: "Accept / agree, warmly and briefly." },
    { label: "Decline politely", text: "Decline politely, keep the relationship warm." },
    { label: "Ask for more time", text: "Acknowledge and ask for a bit more time; propose when I'll get back." },
    { label: "Thank them", text: "Thank them briefly." },
    { label: "Ask a question", text: "Ask the clarifying question(s) this email most needs answered." },
  ];

  function aiReply(text: string, mode: "reply" | "replyAll" = "reply") {
    const acct = app.accountById.get(message.accountId);
    if (!acct) return;
    composer.reply(message, mode);
    composer.streamBody((signal) =>
      draftReply({ message, thread, instruction: text, account: acct, signal }),
    );
    instruction = "";
  }

  function submit(e: Event) {
    e.preventDefault();
    if (instruction.trim()) aiReply(instruction.trim());
  }
</script>

<div class="qr">
  {#if aiOpen && app.aiReady && message.ai?.needsReply && (message.ai.suggestedReply || message.ai.category === "needs_reply")}
    <DraftCard {message} />
  {/if}
  {#if aiOpen && app.aiReady}
    <form class="ask" onsubmit={submit}>
      <Sparkles size={14} />
      <input bind:value={instruction} placeholder="Tell Tern what to reply…  e.g. “yes to Thursday, ask for the agenda”" />
      <button class="send" disabled={!instruction.trim()} aria-label="Draft reply"><ArrowUp size={14} /></button>
    </form>
    <div class="chips">
      {#each CHIPS as c}
        <button class="pill" onclick={() => aiReply(c.text)}>{c.label}</button>
      {/each}
    </div>
  {/if}
  <div class="plain">
    <button class="btn" onclick={() => composer.reply(message, "reply")}><Reply size={14} /> Reply <kbd>r</kbd></button>
    <button class="btn" onclick={() => composer.reply(message, "replyAll")}><ReplyAll size={14} /> Reply all <kbd>R</kbd></button>
    <button class="btn" onclick={() => composer.reply(message, "forward")}><Forward size={14} /> Forward <kbd>f</kbd></button>
    {#if app.aiReady}
      <button class="btn ghost hintbtn" aria-expanded={aiOpen} onclick={() => aiOpen = !aiOpen}><Sparkles size={13} /> {aiOpen ? "Hide writing assistant" : "Draft with AI"}</button>
    {/if}
    {#if !app.aiReady}
      <button class="btn ghost hintbtn" onclick={() => app.openSettings("ai")}><Sparkles size={13} /> Set up AI to draft replies</button>
    {/if}
  </div>
</div>

<style>
  .qr {
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ask {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 6px 0 14px;
    border-radius: 12px;
    color: var(--accent);
    background: color-mix(in oklab, var(--bg-lighter) 55%, transparent);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: box-shadow var(--t);
  }
  .ask:focus-within {
    box-shadow:
      inset 0 0 0 1px var(--accent-line),
      0 0 0 4px var(--accent-soft);
  }
  .ask input {
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    color: var(--fg);
    font-size: 13px;
  }
  .ask input::placeholder {
    color: color-mix(in oklab, var(--fg) 38%, transparent);
  }
  .send {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
    transition: opacity var(--t);
  }
  .send:disabled {
    opacity: 0.3;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    height: 26px;
    padding: 0 11px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--fg-dim);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: all var(--t);
  }
  .pill:hover {
    color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .plain {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .plain kbd {
    font-size: 9.5px;
    padding: 0 4px;
    margin-left: 2px;
  }
  .hintbtn {
    color: var(--accent);
  }
</style>
