<script lang="ts">
  import { onDestroy } from "svelte";
  import { Sparkles, X, Square, WandSparkles } from "@lucide/svelte";
  import type { Account, MessageFull } from "$lib/types";
  import type { ConnectMessage, Conversation } from "$lib/connect";
  import { conversationText } from "$lib/connect";
  import { writeConnect } from "$lib/ai/writing";
  import { app } from "$lib/state/app.svelte";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { errMsg } from "$lib/util/misc";

  let { account, conversation, messages, draft, onUse, onPlan }: {
    account: Account; conversation: Conversation; messages: ConnectMessage[]; draft: string;
    onUse: (text: string) => void; onPlan: (text: string) => void;
  } = $props();
  let mode = $state<"reply" | "summary">("reply");
  let visible = $state(false);
  let instruction = $state("");
  let output = $state("");
  let busy = $state(false);
  let error = $state("");
  let includeMail = $state(false);
  let controller: AbortController | null = null;
  const email = $derived(app.open && (app.open.accountId === account.id || app.accountById.get(app.open.accountId)?.ownerId === account.id) ? app.open : null);
  $effect(() => { void email?.id; includeMail = false; });
  onDestroy(() => controller?.abort());
  function stop() { controller?.abort(); busy = false; }
  async function generate(next: "reply" | "summary", prompt = instruction) {
    if (!app.aiReady) { app.openSettings("ai"); return; }
    stop();
    const ctrl = new AbortController(); controller = ctrl;
    mode = next; visible = true; output = error = ""; busy = true;
    const contextMail: MessageFull | null = includeMail ? email : null;
    try {
      for await (const chunk of writeConnect({ account, title: conversation.title, context: conversationText(messages), draft, mode: next, instruction: prompt || (next === "reply" ? "Suggest a helpful reply for me to review." : "Catch me up on the provided conversation."), email: contextMail, signal: ctrl.signal })) {
        if (ctrl.signal.aborted) return;
        output += chunk;
      }
      if (!output.trim()) error = "No text was returned. Try again with a short instruction.";
    } catch (e) { if (!ctrl.signal.aborted) error = errMsg(e); }
    finally { if (controller === ctrl) busy = false; }
  }
</script>

<div class="assistant">
  <div class="actions"><button type="button" class="text-btn" onclick={() => { visible = !visible; }}><Sparkles size={13} /> Writing assistant</button><button type="button" class="text-btn" disabled={busy || !messages.length} onclick={() => generate("summary")}><WandSparkles size={13} /> Catch me up</button></div>
  {#if visible}
    <div class="studio">
      <div class="studio-title"><strong>{mode === "summary" ? "Conversation catch-up" : "A reply in your voice"}</strong><button type="button" class="icon-btn" aria-label="Close writing assistant" onclick={() => { stop(); visible = false; }}><X size={13} /></button></div>
      {#if !app.aiReady}<p>Add an AI provider to draft replies and summarize conversations.</p><button type="button" class="btn" onclick={() => app.openSettings("ai")}>Set up AI</button>
      {:else}
        <input aria-label="Reply instructions" placeholder="What would you like to say? (optional)" bind:value={instruction} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void generate("reply"); } }} />
        {#if email}<label><input type="checkbox" bind:checked={includeMail} /> Include open email: {email.subject || "(no subject)"}</label>{/if}
        <div class="presets"><button type="button" disabled={busy} onclick={() => generate("reply")}>Draft reply</button><button type="button" disabled={busy || !draft.trim()} onclick={() => generate("reply", "Make my existing draft shorter while preserving its meaning.")}>Shorter</button><button type="button" disabled={busy || !draft.trim()} onclick={() => generate("reply", "Make my existing draft warmer while preserving its meaning and commitments.")}>Warmer</button><button type="button" disabled={busy || !messages.length} onclick={() => generate("reply", "Draft a polite clarifying question about the latest message. Do not invent missing information.")}>Ask a question</button></div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if output}
          {#if mode === "summary"}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="output" onclick={mdLinkHandler}>{@html md(output)}</div>
          {:else}<div class="output plain">{output}</div>{/if}
        {/if}
        <div class="footer">
          {#if busy}<button type="button" class="text-btn" onclick={stop}><Square size={11} /> Stop generating</button>
          {:else if output.trim()}{#if mode === "reply"}<button type="button" class="btn primary" onclick={() => { onUse(output.trim()); visible = false; }}>{draft.trim() ? "Replace draft" : "Use as reply"}</button>{:else}<button type="button" class="btn" onclick={() => onPlan(output)}>Plan a follow-up meeting</button>{/if}{/if}
          <span>Review before sending · {Math.min(messages.length, 40)} loaded messages</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
<style>
  .assistant { padding: 0 0 8px; }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .text-btn { color: var(--accent); display: flex; align-items: center; gap: 5px; font-size: 11px; padding: 5px 0; }
  .studio { border: 1px solid var(--accent-line); background: var(--panel); border-radius: 9px; padding: 10px; margin-top: 5px; }
  .studio-title { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
  input:not([type="checkbox"]) { width: 100%; border: 1px solid var(--line); border-radius: 6px; color: var(--fg); background: var(--surface); font-size: 12px; padding: 7px; margin-top: 8px; }
  label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; padding: 8px 0; }
  .presets { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .presets button { background: var(--accent-soft); color: var(--accent); padding: 5px 8px; border-radius: 5px; font-size: 10px; }
  .output { margin-top: 10px; max-height: 190px; overflow-y: auto; user-select: text; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  .plain { white-space: pre-wrap; }
  .footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
  .footer span, p { color: var(--muted); font-size: 10px; }
  .error { color: var(--red); }
  button:disabled { opacity: .45; }
</style>
