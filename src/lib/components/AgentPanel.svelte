<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { agent } from "$lib/state/agent.svelte";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { tick } from "svelte";
  import {
    X,
    Sparkles,
    ArrowUp,
    Square,
    Check,
    LoaderCircle,
    CircleAlert,
    RotateCcw,
    ShieldCheck,
    Ban,
  } from "@lucide/svelte";
  import Logo from "./Logo.svelte";

  let text = $state("");
  let input: HTMLTextAreaElement | undefined = $state();
  let scroller: HTMLDivElement | undefined = $state();

  // Suggestions follow what the user is looking at.
  const suggestions = $derived.by(() => {
    const out: string[] = [];
    const m = app.open;
    if (m) {
      const who = m.from.name?.split(/\s+/)[0] || m.from.email;
      out.push(
        "Summarize this thread",
        `Draft a reply to ${who} declining politely`,
        "What is being asked of me here?",
        `Find everything else from ${who}`,
      );
    } else if (app.view.kind === "today") {
      out.push("Plan my inbox for today", "What's my next meeting about?", "Find 30 min with Marcus this week", "Who is waiting on me, and for how long?");
    } else if (app.view.kind === "agenda") {
      out.push("Find 30 min with Marcus this week", "What's my next meeting about?", "Clear my Friday afternoon — propose what to move", "Which invitations haven't I answered?");
    } else if (app.view.kind === "search") {
      out.push(`Dig deeper: find mail about “${app.view.query}”`, "Summarize these results");
    } else if (app.view.kind === "category") {
      out.push(`Summarize everything in ${app.viewTitle}`, `Archive everything in ${app.viewTitle} older than a week`);
    } else {
      out.push("What needs my attention today?", "Summarize unread from the last 24 hours");
    }
    out.push("Archive all newsletters older than a week", "Find the latest invoice and tell me the amount");
    return [...new Set(out)].slice(0, 6);
  });

  $effect(() => {
    if (app.agentOpen) tick().then(() => input?.focus());
  });
  $effect(() => {
    if (app.agentPrefill != null) {
      text = app.agentPrefill;
      app.agentPrefill = null;
      tick().then(() => {
        input?.focus();
        autosize();
      });
    }
  });

  // Auto-scroll as content streams in.
  $effect(() => {
    void agent.items.length;
    const last = agent.items[agent.items.length - 1];
    if (last && last.kind === "assistant") void last.text;
    tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }));
  });

  function submit(e?: Event) {
    e?.preventDefault();
    if (!text.trim() || agent.busy) return;
    agent.send(text);
    text = "";
    autosize();
  }

  function autosize() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (agent.busy) agent.abort();
      else app.agentOpen = false;
    }
  }

  // y / n resolve a pending approval when focus isn't in the textarea.
  function onWindowKey(e: KeyboardEvent) {
    if (!app.agentOpen || !agent.pendingApproval) return;
    const t = e.target as HTMLElement;
    if (t?.tagName === "TEXTAREA" || t?.tagName === "INPUT") return;
    if (e.key === "y" || e.key === "n") {
      e.preventDefault();
      e.stopPropagation();
      agent.resolve(agent.pendingApproval.callId, e.key === "y");
    }
  }
</script>

<svelte:window onkeydowncapture={onWindowKey} />

{#if app.agentOpen}
  <aside class="panel">
    <header>
      <span class="spark"><Sparkles size={15} /></span>
      <span class="title">Tern</span>
      <span class="sub">agent</span>
      <span class="spacer"></span>
      {#if agent.items.length}
        <button class="icon-btn s" title="New conversation" onclick={() => agent.reset()}><RotateCcw size={14} /></button>
      {/if}
      <button class="icon-btn s" title="Close (Esc)" onclick={() => (app.agentOpen = false)}><X size={15} /></button>
    </header>

    <div class="scroll" bind:this={scroller}>
      {#if !app.aiReady}
        <div class="intro">
          <div class="mark"><Logo size={36} /></div>
          <h3>Your inbox, with an assistant</h3>
          <p>Connect Claude or any OpenAI-compatible model to search, summarize, triage and draft across all your accounts.</p>
          <button class="btn primary" onclick={() => app.openSettings("ai")}>Set up AI</button>
        </div>
      {:else if !agent.items.length}
        <div class="intro">
          <div class="mark"><Logo size={36} /></div>
          <h3>What can I do for you?</h3>
          <p>I can read, search, sort and draft mail. I'll always ask before sending or deleting anything.</p>
          <div class="sugg">
            {#each suggestions as s (s)}
              <button onclick={() => agent.send(s)}>{s}</button>
            {/each}
          </div>
        </div>
      {:else}
        <div class="log">
          {#each agent.items as it (it.id)}
            {#if it.kind === "user"}
              <div class="user">{it.text}</div>
            {:else if it.kind === "assistant"}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="assistant md" onclick={mdLinkHandler}>{@html md(it.text)}</div>
            {:else if it.kind === "tool"}
              <div class="tool {it.status}">
                <span class="ti">
                  {#if it.status === "running"}<LoaderCircle size={12} class="spin" />
                  {:else if it.status === "ok"}<Check size={12} strokeWidth={3} />
                  {:else}<CircleAlert size={12} />{/if}
                </span>
                <span class="tl">{it.label}</span>
                {#if it.summary}<span class="ts">{it.summary}</span>{/if}
              </div>
            {:else if it.kind === "approval"}
              <div class="approval {it.state}">
                <div class="ah">
                  <ShieldCheck size={14} />
                  <span>{it.label}</span>
                </div>
                <pre class="preview">{it.preview}</pre>
                {#if it.state === "pending"}
                  <div class="abtns">
                    <button class="btn primary sm" onclick={() => agent.resolve(it.callId, true)}>Approve <kbd>y</kbd></button>
                    <button class="btn sm" onclick={() => agent.resolve(it.callId, false)}>Deny <kbd>n</kbd></button>
                  </div>
                {:else}
                  <div class="astate">
                    {#if it.state === "approved"}<Check size={12} /> Approved{:else}<Ban size={12} /> Denied{/if}
                  </div>
                {/if}
              </div>
            {:else if it.kind === "error"}
              <div class="error"><CircleAlert size={13} /> {it.text}</div>
            {/if}
          {/each}
          {#if agent.thinking}
            <div class="thinking shimmer-text">Thinking…</div>
          {/if}
        </div>
      {/if}
    </div>

    <form class="composer" onsubmit={submit}>
      <textarea
        bind:this={input}
        bind:value={text}
        rows="1"
        placeholder={app.aiReady ? "Ask anything about your mail…" : "Set up AI in Settings first"}
        disabled={!app.aiReady}
        oninput={autosize}
        {onkeydown}></textarea>
      {#if agent.busy}
        <button type="button" class="send stop" title="Stop" onclick={() => agent.abort()}><Square size={11} fill="currentColor" /></button>
      {:else}
        <button class="send" disabled={!text.trim()} aria-label="Send"><ArrowUp size={15} /></button>
      {/if}
    </form>
  </aside>
{/if}

<style>
  .panel {
    position: fixed;
    top: 54px;
    right: 8px;
    bottom: 8px;
    z-index: 45;
    width: min(440px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    border-radius: 16px;
    background: color-mix(in oklab, var(--bg-darker) 55%, var(--bg));
    box-shadow: var(--shadow);
    animation: slide 220ms var(--ease);
    overflow: hidden;
  }
  :global([data-translucent="true"]) .panel {
    background: rgba(var(--bg-rgb), 0.82);
    backdrop-filter: blur(24px) saturate(1.2);
  }
  @keyframes slide {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 46px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--line);
  }
  .spark {
    display: grid;
    color: var(--accent);
  }
  .title {
    font-weight: 680;
    letter-spacing: -0.01em;
  }
  .sub {
    font-size: 11px;
    color: var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .icon-btn.s {
    width: 28px;
    height: 28px;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }
  .intro {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 24px 6px;
    animation: fade-up 240ms var(--ease);
  }
  .mark {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: radial-gradient(circle at 30% 25%, var(--accent-soft), transparent 75%);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .intro h3 {
    margin: 6px 0 0;
    font-size: 17px;
    font-weight: 680;
    letter-spacing: -0.015em;
    color: var(--fg-bright);
  }
  .intro p {
    margin: 0;
    color: var(--fg-dim);
    font-size: 13px;
    line-height: 1.55;
  }
  .sugg {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    margin-top: 10px;
  }
  .sugg button {
    text-align: left;
    padding: 9px 12px;
    border-radius: 10px;
    font-size: 12.5px;
    color: var(--fg-dim);
    box-shadow: inset 0 0 0 1px var(--line);
    transition: all var(--t);
  }
  .sugg button:hover {
    color: var(--fg);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .log {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .user {
    align-self: flex-end;
    max-width: 85%;
    padding: 8px 13px;
    border-radius: 14px 14px 4px 14px;
    background: var(--accent-soft);
    color: var(--fg-bright);
    font-size: 13px;
    white-space: pre-wrap;
    user-select: text;
    animation: fade-up 160ms var(--ease);
  }
  .assistant {
    font-size: 13.5px;
    color: var(--fg);
  }
  .tool {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    font-size: 12px;
    color: var(--muted);
    animation: fade-up 160ms var(--ease);
  }
  .ti {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    flex: none;
    background: var(--hover);
  }
  .tool.ok .ti {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 15%, transparent);
  }
  .tool.error .ti {
    color: var(--red);
  }
  .tool.running .tl {
    color: var(--fg-dim);
  }
  .ts {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    opacity: 0.8;
  }
  .ts::before {
    content: "· ";
  }
  .approval {
    padding: 12px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--accent) 7%, var(--bg));
    box-shadow: inset 0 0 0 1px var(--accent-line);
    animation: fade-up 180ms var(--ease);
  }
  .approval.denied,
  .approval.approved {
    box-shadow: inset 0 0 0 1px var(--line);
    background: var(--hover);
  }
  .ah {
    display: flex;
    align-items: center;
    gap: 7px;
    font-weight: 620;
    font-size: 12.5px;
    color: var(--accent);
  }
  .preview {
    margin: 8px 0 10px;
    max-height: 220px;
    overflow: auto;
    padding: 9px 11px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--bg-darker) 60%, transparent);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    color: var(--fg-dim);
    user-select: text;
  }
  .abtns {
    display: flex;
    gap: 6px;
  }
  .abtns kbd {
    font-size: 9.5px;
    padding: 0 4px;
    background: transparent;
  }
  .astate {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .error {
    display: flex;
    gap: 7px;
    align-items: flex-start;
    font-size: 12.5px;
    color: var(--red);
    padding: 8px 10px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--red) 10%, transparent);
    user-select: text;
  }
  .thinking {
    font-size: 12.5px;
    font-weight: 550;
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin: 0 12px 12px;
    padding: 8px 8px 8px 14px;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 55%, transparent);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: box-shadow var(--t);
  }
  .composer:focus-within {
    box-shadow:
      inset 0 0 0 1px var(--accent-line),
      0 0 0 4px var(--accent-soft);
  }
  textarea {
    flex: 1;
    resize: none;
    border: 0;
    outline: 0;
    background: none;
    font-size: 13.5px;
    line-height: 1.5;
    padding: 4px 0;
    max-height: 160px;
  }
  textarea::placeholder {
    color: color-mix(in oklab, var(--fg) 38%, transparent);
  }
  .send {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: var(--accent);
    color: var(--on-accent);
    flex: none;
    transition: opacity var(--t);
  }
  .send:disabled {
    opacity: 0.3;
  }
  .send.stop {
    background: var(--hover);
    color: var(--fg);
  }
</style>
