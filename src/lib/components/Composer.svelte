<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { draftReply, rewrite } from "$lib/ai";
  import { htmlToText } from "$lib/util/misc";
  import { hueColor } from "$lib/theme";
  import AddressInput from "./AddressInput.svelte";
  import EmojiPicker from "./EmojiPicker.svelte";
  import {
    X,
    Minus,
    Maximize2,
    Minimize2,
    Send,
    Clock,
    Sparkles,
    Bold,
    Italic,
    Underline,
    List,
    Link,
    Square,
    Trash2,
    ArrowUp,
  } from "@lucide/svelte";

  let editor: HTMLDivElement | undefined = $state();
  let big = $state(false);
  let aiText = $state("");
  let showQuote = $state(false);
  let emojiRange: Range | null = null;

  function rememberCaret() {
    const selection = window.getSelection();
    if (editor && selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      emojiRange = selection.getRangeAt(0).cloneRange();
    }
  }
  function addEmoji(emoji: string) {
    if (!editor || composer.aiBusy) return;
    editor.focus();
    const selection = window.getSelection();
    const range = emojiRange && editor.contains(emojiRange.commonAncestorContainer) ? emojiRange : document.createRange();
    if (range !== emojiRange) { range.selectNodeContents(editor); range.collapse(false); }
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, emoji);
    oninput();
    rememberCaret();
  }

  const d = $derived(composer.draft);
  const title = $derived(
    d ? (d.subject || (d.mode === "new" ? "New message" : d.mode === "forward" ? "Forward" : "Reply")) : "",
  );

  // Push body into the editor when it changes from outside (open / AI streaming).
  $effect(() => {
    void composer.bodyVersion;
    if (editor && composer.draft && editor.innerHTML !== composer.draft.bodyHtml) {
      editor.innerHTML = composer.draft.bodyHtml;
      if (composer.aiBusy) editor.scrollTop = editor.scrollHeight;
    }
  });

  // Focus: replies → body; new → To.
  let focusedFor: unknown = null;
  $effect(() => {
    const draft = composer.draft;
    if (draft && focusedFor !== draft && editor && draft.mode !== "new" && draft.to.length) {
      focusedFor = draft;
      setTimeout(() => editor?.focus(), 30);
    }
  });

  function oninput() {
    if (composer.draft && editor) composer.draft.bodyHtml = editor.innerHTML;
  }

  function exec(cmd: string, val?: string) {
    editor?.focus();
    document.execCommand(cmd, false, val);
    oninput();
  }

  // ---- send later ----
  let laterOpen = $state(false);
  let laterCustom = $state("");
  function laterPresets() {
    const now = new Date();
    const d = (days: number, h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    const hint = (x: Date) => `${x.toLocaleDateString("en-GB", { weekday: "short" })} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
    const out: { label: string; at: Date; hint: string }[] = [];
    if (now.getHours() < 16) {
      const a = new Date(now.getTime() + 2 * 3_600_000);
      a.setSeconds(0, 0);
      a.setMinutes(Math.ceil(a.getMinutes() / 15) * 15);
      out.push({ label: "In two hours", at: a, hint: hint(a) });
    }
    const tm = d(1, 8);
    out.push({ label: "Tomorrow morning", at: tm, hint: hint(tm) });
    const dow = now.getDay();
    const mon = d(((8 - dow) % 7) || 7, 8);
    out.push({ label: "Monday morning", at: mon, hint: hint(mon) });
    return out;
  }
  function sendLater(at: Date) {
    if (Number.isNaN(at.getTime())) return;
    laterOpen = false;
    composer.send(at);
  }

  function addLink() {
    const url = prompt("Link URL");
    if (url) exec("createLink", url);
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      composer.send();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b" && e.target === editor) {
      e.preventDefault();
      exec("bold");
    }
  }

  function runAi(instruction: string) {
    const draft = composer.draft;
    if (!draft || !instruction.trim()) return;
    const current = htmlToText(draft.bodyHtml);
    const acct = app.accountById.get(draft.accountId);
    if (!current.trim() && draft.ref && acct && draft.mode !== "forward") {
      const ref = draft.ref;
      composer.streamBody((signal) =>
        draftReply({ message: ref, instruction, account: acct, signal }),
      );
    } else if (!current.trim()) {
      const ctx = [
        "Write a new email from scratch.",
        draft.subject ? `Subject: ${draft.subject}` : "",
        draft.to.length ? `To: ${draft.to.map((a) => a.name || a.email).join(", ")}` : "",
        acct ? `From: ${acct.displayName} <${acct.email}>` : "",
        `What it should say: ${instruction}`,
        "Return only the body text, no subject line, no signature.",
      ]
        .filter(Boolean)
        .join("\n");
      composer.streamBody((signal) => rewrite("", ctx, signal));
    } else {
      composer.streamBody((signal) => rewrite(current, instruction, signal));
    }
    aiText = "";
  }

  const QUICK = [
    { label: "Shorten", text: "Make it shorter and tighter. Keep all facts." },
    { label: "More formal", text: "Make it more formal and polished." },
    { label: "Friendlier", text: "Make it warmer and friendlier, still professional." },
    { label: "Fix grammar", text: "Fix spelling and grammar only. Keep wording otherwise." },
    { label: "→ English", text: "Translate to English." },
    { label: "→ Svenska", text: "Translate to Swedish." },
  ];
</script>

{#if d}
  {#if composer.minimized}
    <button class="pill" onclick={() => (composer.minimized = false)}>
      <span class="pdot"></span>
      <span>{title}</span>
      {#if composer.aiBusy}<Sparkles size={12} class="spin" />{/if}
    </button>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="sheet" data-composer class:big {onkeydown}>
      <header>
        <span class="t">{title}</span>
        <button class="icon-btn s" title="Minimize (Esc)" onclick={() => (composer.minimized = true)}><Minus size={14} /></button>
        <button class="icon-btn s" title={big ? "Dock" : "Expand"} onclick={() => (big = !big)}>
          {#if big}<Minimize2 size={13} />{:else}<Maximize2 size={13} />{/if}
        </button>
        <button class="icon-btn s" title="Close" onclick={() => composer.close()}><X size={14} /></button>
      </header>

      <div class="fields">
        {#if app.mailAccounts.length > 1}
          <div class="from">
            <span class="lbl">From</span>
            <span class="fdot" style:background={hueColor(app.accountById.get(d.accountId)?.hue ?? 0, app.mode)}></span>
            <select bind:value={d.accountId}>
              {#each app.mailAccounts as a (a.id)}
                <option value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>
              {/each}
            </select>
          </div>
        {/if}
        <div class="row-to">
          <AddressInput label="To" bind:value={d.to} autofocus={d.mode === "new" || !d.to.length} />
          {#if !d.showCc}
            <button class="cc-toggle" onclick={() => (d.showCc = true)}>Cc Bcc</button>
          {/if}
        </div>
        {#if d.showCc}
          <AddressInput label="Cc" bind:value={d.cc} />
          <AddressInput label="Bcc" bind:value={d.bcc} />
        {/if}
        <input class="subject" placeholder="Subject" bind:value={d.subject} />
      </div>

      <div class="editor-wrap">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="editor"
          class:busy={composer.aiBusy}
          bind:this={editor}
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          tabindex="0"
          data-placeholder={app.aiReady ? "Write, or tell Tern what to say below…" : "Write your message…"}
          onkeyup={rememberCaret}
          onmouseup={rememberCaret}
          onfocusout={rememberCaret}
          {oninput}></div>

        {#if app.settings?.signatures?.[d.accountId]}
          <div class="sig">{@html app.settings.signatures[d.accountId]}</div>
        {/if}
        {#if d.quoteHtml && d.mode !== "new"}
          <button class="quote-toggle" onclick={() => (showQuote = !showQuote)}>{showQuote ? "Hide" : "···"} quoted text</button>
          {#if showQuote}<div class="quote">{@html d.quoteHtml}</div>{/if}
        {/if}
      </div>

      {#if app.aiReady}
        <div class="ai">
          <form class="ai-in" onsubmit={(e) => { e.preventDefault(); runAi(aiText); }}>
            <Sparkles size={14} />
            <input bind:value={aiText} placeholder={composer.aiBusy ? "Writing…" : "Ask Tern to write or change this draft…"} disabled={composer.aiBusy} />
            {#if composer.aiBusy}
              <button type="button" class="stop" onclick={() => composer.stopAi()} title="Stop"><Square size={11} fill="currentColor" /></button>
            {:else}
              <button class="go" disabled={!aiText.trim()} aria-label="Run"><ArrowUp size={13} /></button>
            {/if}
          </form>
          <div class="quick">
            {#each QUICK as q}
              <button disabled={composer.aiBusy} onclick={() => runAi(q.text)}>{q.label}</button>
            {/each}
          </div>
        </div>
      {/if}

      <footer>
        <div class="sendgrp">
          <button class="btn primary" onclick={() => composer.send()} disabled={composer.aiBusy}>
            <Send size={14} /> Send <kbd>^↵</kbd>
          </button>
          <button class="btn primary later" onclick={() => (laterOpen = !laterOpen)} disabled={composer.aiBusy} title="Send later" aria-label="Send later"><Clock size={14} /></button>
          {#if laterOpen}
            <div class="latermenu" role="menu">
              {#each laterPresets() as p (p.label)}
                <button role="menuitem" onclick={() => sendLater(p.at)}><span>{p.label}</span><span class="mono">{p.hint}</span></button>
              {/each}
              <div class="lc">
                <input type="datetime-local" class="field" bind:value={laterCustom} step="900" />
                <button class="btn sm" onclick={() => sendLater(new Date(laterCustom))} disabled={!laterCustom}>Schedule</button>
              </div>
              <div class="lh">Outlook holds it and sends at that time, even if Tern is closed.</div>
            </div>
          {/if}
        </div>
        <div class="fmt">
          <EmojiPicker onOpen={rememberCaret} onSelect={addEmoji} disabled={composer.aiBusy} />
          <button class="icon-btn s" title="Bold" onclick={() => exec("bold")}><Bold size={14} /></button>
          <button class="icon-btn s" title="Italic" onclick={() => exec("italic")}><Italic size={14} /></button>
          <button class="icon-btn s" title="Underline" onclick={() => exec("underline")}><Underline size={14} /></button>
          <button class="icon-btn s" title="Bulleted list" onclick={() => exec("insertUnorderedList")}><List size={14} /></button>
          <button class="icon-btn s" title="Link" onclick={addLink}><Link size={14} /></button>
        </div>
        <span class="spacer"></span>
        <button class="icon-btn s" title="Discard" onclick={() => composer.close()}><Trash2 size={14} /></button>
      </footer>
    </div>
  {/if}
{/if}

<style>
  .sheet {
    position: fixed;
    right: 22px;
    bottom: 0;
    z-index: 40;
    width: min(640px, calc(100vw - 40px));
    height: min(660px, calc(100vh - 80px));
    display: flex;
    flex-direction: column;
    border-radius: 14px 14px 0 0;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: var(--shadow);
    animation: rise 220ms var(--ease);
    user-select: text;
  }
  .sheet.big {
    right: 50%;
    bottom: 50%;
    transform: translate(50%, 50%);
    width: min(900px, calc(100vw - 80px));
    height: min(820px, calc(100vh - 80px));
    border-radius: 16px;
    animation: none;
  }
  @keyframes rise {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 40px;
    padding: 0 8px 0 18px;
    border-bottom: 1px solid var(--line);
  }
  .t {
    flex: 1;
    font-weight: 620;
    font-size: 13px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .icon-btn.s {
    width: 26px;
    height: 26px;
  }
  .fields {
    padding: 2px 18px 0;
  }
  .from {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .lbl {
    width: 34px;
    font-size: 12px;
    color: var(--muted);
  }
  .fdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-left: -4px;
  }
  select {
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    font-size: 13px;
    color: var(--fg);
  }
  select option {
    background: var(--bg);
  }
  .row-to {
    position: relative;
  }
  .cc-toggle {
    position: absolute;
    right: 0;
    top: 10px;
    font-size: 11.5px;
    color: var(--muted);
    padding: 2px 6px;
    border-radius: 5px;
  }
  .cc-toggle:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .subject {
    width: 100%;
    height: 42px;
    border: 0;
    border-bottom: 1px solid var(--line);
    outline: 0;
    background: none;
    font-size: 14.5px;
    font-weight: 600;
  }
  .subject::placeholder {
    color: var(--muted);
    font-weight: 500;
  }
  .editor-wrap {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 18px;
  }
  .editor {
    min-height: 140px;
    outline: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--fg);
  }
  .editor:empty::before {
    content: attr(data-placeholder);
    color: var(--muted);
    pointer-events: none;
  }
  .editor.busy {
    caret-color: transparent;
  }
  .editor :global(p) {
    margin: 0 0 0.8em;
  }
  .editor :global(a) {
    color: var(--accent);
  }
  .sig {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px dashed var(--line);
    font-size: 12.5px;
    color: var(--fg-dim);
    opacity: 0.8;
  }
  .quote-toggle {
    margin-top: 12px;
    font-size: 11.5px;
    color: var(--muted);
    padding: 2px 8px;
    border-radius: 5px;
    background: var(--hover);
  }
  .quote {
    margin-top: 10px;
    font-size: 12.5px;
    color: var(--fg-dim);
    max-height: 300px;
    overflow: auto;
  }
  .quote :global(img) {
    max-width: 100%;
  }
  .ai {
    padding: 10px 14px 4px;
    border-top: 1px solid var(--line);
    background: linear-gradient(180deg, color-mix(in oklab, var(--accent) 5%, transparent), transparent);
  }
  .ai-in {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 36px;
    padding: 0 5px 0 12px;
    border-radius: 10px;
    color: var(--accent);
    background: color-mix(in oklab, var(--bg-darker) 45%, transparent);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .ai-in:focus-within {
    box-shadow:
      inset 0 0 0 1px var(--accent-line),
      0 0 0 3px var(--accent-soft);
  }
  .ai-in input {
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    font-size: 12.5px;
  }
  .go,
  .stop {
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
  .stop {
    background: var(--hover);
    color: var(--fg);
  }
  .quick {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding: 8px 0 4px;
  }
  .quick button {
    height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 11.5px;
    color: var(--fg-dim);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .quick button:hover:not(:disabled) {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .quick button:disabled {
    opacity: 0.4;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 12px 14px;
  }
  .sendgrp {
    position: relative;
    display: inline-flex;
    gap: 1px;
  }
  .sendgrp > .btn.primary:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .later {
    padding: 0 8px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  .latermenu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    width: 270px;
    padding: 6px;
    border-radius: 12px;
    background: var(--raised);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 2px;
    animation: fade-up 140ms var(--ease);
  }
  .latermenu > button {
    display: flex;
    justify-content: space-between;
    height: 30px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--fg);
  }
  .latermenu > button:hover {
    background: var(--accent-soft);
  }
  .latermenu .mono {
    font-size: 11px;
    color: var(--muted);
  }
  .lc {
    display: flex;
    gap: 6px;
    padding: 6px 4px 2px;
    border-top: 1px solid var(--line);
    margin-top: 4px;
  }
  .lc .field {
    height: 28px;
    font-size: 11.5px;
    font-family: var(--font-mono);
  }
  .lh {
    font-size: 10.5px;
    color: var(--muted);
    padding: 2px 6px 2px;
  }
  footer kbd {
    background: transparent;
    border-color: color-mix(in oklab, var(--on-accent) 25%, transparent);
    color: color-mix(in oklab, var(--on-accent) 70%, transparent);
  }
  .fmt {
    display: flex;
    gap: 0;
    margin-left: 6px;
  }
  .spacer {
    flex: 1;
  }
  .pill {
    position: fixed;
    right: 22px;
    bottom: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 38px;
    max-width: 320px;
    padding: 0 16px;
    border-radius: 12px 12px 0 0;
    background: color-mix(in oklab, var(--bg-lighter) 70%, var(--bg));
    box-shadow: var(--shadow);
    font-size: 12.5px;
    font-weight: 600;
  }
  .pill span:nth-child(2) {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
