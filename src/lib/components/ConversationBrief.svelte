<script lang="ts">
  import { onDestroy } from "svelte";
  import { Sparkles, X, ArrowUpRight, Check, ListTodo, CircleHelp, RefreshCw, Square } from "@lucide/svelte";
  import type { Account } from "$lib/types";
  import type { ConnectMessage, Conversation } from "$lib/connect";
  import { briefSources, briefContext, parseBrief, type ConversationBrief } from "$lib/util/connect-experience";
  import { writeConnect } from "$lib/ai/writing";
  import { app } from "$lib/state/app.svelte";
  import { errMsg } from "$lib/util/misc";

  let { account, conversation, messages, onSource, onDraft, onPlan, visible = $bindable(false) }: {
    account: Account; conversation: Conversation; messages: ConnectMessage[]; visible?: boolean;
    onSource: (id: string) => void; onDraft: (text: string) => void; onPlan: (text: string) => void;
  } = $props();
  let busy = $state(false);
  let error = $state("");
  let brief = $state<ConversationBrief | null>(null);
  let snapshot = $state("");
  let sourceCount = $state(0);
  let controller: AbortController | null = null;
  const sources = $derived(briefSources(messages));
  const stale = $derived(!!brief && snapshot !== briefContext(sources));
  onDestroy(() => controller?.abort());
  function stop() { controller?.abort(); busy = false; }
  async function generate() {
    visible = true;
    if (!app.aiReady || !sources.length) return;
    stop();
    const ctrl = new AbortController(); controller = ctrl;
    const captured = sources;
    const context = briefContext(captured);
    busy = true; error = "";
    try {
      let output = "";
      for await (const chunk of writeConnect({ account, title: conversation.title, context, draft: "", mode: "brief", instruction: "Create an evidence-linked conversation brief from these messages.", signal: ctrl.signal })) {
        if (ctrl.signal.aborted) return;
        output += chunk;
      }
      if (ctrl.signal.aborted) return;
      brief = parseBrief(output, captured);
      snapshot = context; sourceCount = captured.length;
    } catch (e) { if (!ctrl.signal.aborted) error = errMsg(e); }
    finally { if (controller === ctrl) busy = false; }
  }
  function followUp() {
    if (!brief) return "";
    return [brief.summary, ...brief.cards.filter(c => c.kind !== "decision").map(c => `• ${c.text}`)].join("\n\n");
  }
</script>

<div class="brief-feature" class:expanded={visible}>
  <button type="button" class="launch" aria-expanded={visible} disabled={!sources.length} onclick={() => { if (visible) { stop(); visible = false; } else if (brief) visible = true; else void generate(); }}><Sparkles size={14} /><span>Conversation brief</span><small>See what matters</small></button>
  {#if visible}
    <section class="brief" aria-label="Conversation brief" aria-busy={busy}>
      <header><div><span class="eyebrow">FROM CONVERSATION TO CLARITY</span><h3>The thread, untangled.</h3></div><button type="button" class="icon-btn" aria-label="Close conversation brief" onclick={() => { stop(); visible = false; }}><X size={15} /></button></header>
      {#if !app.aiReady}<p>Turn your conversation into decisions, next steps, and open questions.</p><button type="button" class="btn" onclick={() => app.openSettings("ai")}>Set up AI</button>
      {:else}
        {#if busy}<div class="generating" role="status"><Sparkles size={18} /><span>Connecting the dots in {sources.length} messages…</span><button type="button" class="icon-btn" aria-label="Stop generating brief" onclick={stop}><Square size={12} /></button></div>{/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if brief}
          <p class="summary">{brief.summary}</p>
          <div class="cards">
            {#each brief.cards as card, index}
              <article class="brief-card" style={`--card-index: ${index}`}>
                <div class="card-label">{#if card.kind === "decision"}<Check size={13} />Decision{:else if card.kind === "action"}<ListTodo size={13} />Next step{:else}<CircleHelp size={13} />Open question{/if}</div>
                <p>{card.text}</p>
                <div class="sources">{#each card.sourceIds as id, i}<button type="button" onclick={() => { visible = false; onSource(id); }}>Source{card.sourceIds.length > 1 ? ` ${i + 1}` : ""}<ArrowUpRight size={11} /></button>{/each}</div>
              </article>
            {:else}<p>No explicit decisions, next steps, or open questions in these messages.</p>{/each}
          </div>
          <div class="handoffs"><button type="button" class="btn" disabled={busy} onclick={() => { visible = false; onDraft(followUp()); }}>Add to draft</button><button type="button" class="btn" disabled={busy} onclick={() => onPlan(followUp())}>Plan follow-up</button></div>
          <p class="scope">AI brief · {sourceCount} loaded messages · Check sources before acting.</p>
          {#if stale}<p class="scope">The conversation has changed. Refresh to include the latest messages.</p>{/if}
        {/if}
        {#if !busy}<button type="button" class="refresh" onclick={generate}><RefreshCw size={12} />{error ? "Try again" : brief ? "Refresh brief" : "Generate brief"}</button>{/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .brief-feature { flex: 0 1 auto; min-height: 36px; border-bottom: 1px solid var(--line); max-height: 45%; overflow-y: auto; }
  .brief-feature.expanded { flex: 1; max-height: none; min-height: 0; }
  .launch { display: flex; align-items: center; gap: 7px; width: 100%; padding: 10px 15px; color: var(--accent); font-size: 12px; text-align: left; }
  .launch:hover { background: var(--accent-soft); }
  .launch small { margin-left: auto; color: var(--muted); font-size: 10px; }
  .brief { margin: 0 12px 12px; padding: 16px; border: 1px solid var(--accent-line); border-radius: 12px; background: linear-gradient(135deg, var(--accent-soft), var(--panel) 65%); }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .eyebrow { color: var(--accent); font-size: 9px; letter-spacing: .09em; }
  h3 { margin: 6px 0 12px; font-size: 19px; font-weight: 550; letter-spacing: -.04em; color: var(--fg-bright); }
  p { font-size: 12px; line-height: 1.6; margin: 8px 0; overflow-wrap: anywhere; }
  .summary { color: var(--fg-bright); margin: 0 0 14px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 8px; }
  .brief-card { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 12px; animation: reveal .3s ease both; animation-delay: calc(var(--card-index) * 40ms); }
  .card-label, .sources, .sources button, .refresh, .generating { display: flex; align-items: center; gap: 5px; }
  .card-label { color: var(--accent); font-size: 10px; font-weight: 600; }
  .sources { flex-wrap: wrap; }
  .sources button, .refresh { color: var(--accent); font-size: 10px; padding: 4px 0; }
  .handoffs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  .scope { color: var(--muted); font-size: 10px; }
  .generating { font-size: 12px; color: var(--accent); padding: 12px 0; }
  .generating span { flex: 1; }
  .error { color: var(--red); }
  button:disabled { opacity: .5; }
  @keyframes reveal { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .brief-card { animation: none; } }
</style>
