<script lang="ts">
  import { app, CATEGORY_META, SMART_CATEGORIES, wkLabel, type UiView } from "$lib/state/app.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { agent } from "$lib/state/agent.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { fuzzyScore } from "$lib/util/fuzzy";
  import type { WellKnownFolder } from "$lib/types";
  import { tick } from "svelte";
  import { Sparkles, CornerDownLeft, Search } from "@lucide/svelte";

  interface Cmd {
    id: string;
    label: string;
    group: string;
    hint?: string;
    run: () => void;
  }

  let q = $state("");
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (app.paletteOpen) {
      q = "";
      active = 0;
      tick().then(() => input?.focus());
    }
  });

  const go = (v: UiView) => () => app.setView(v);
  function findTimePrefill() {
    // Hand the agent panel a prefilled prompt; the panel picks it up via this tick.
    app.agentPrefill = "Find 30 min with ";
  }

  const commands = $derived.by<Cmd[]>(() => {
    const cmds: Cmd[] = [
      { id: "compose", label: "Compose new message", group: "Actions", hint: "c", run: () => composer.compose() },
      { id: "sync", label: "Sync all accounts", group: "Actions", hint: "^R", run: () => app.syncNow() },
      { id: "triage", label: "Run AI triage on new mail", group: "Actions", run: () => app.runTriage() },
      { id: "unread", label: app.unreadOnly ? "Show all mail" : "Show unread only", group: "Actions", hint: "U", run: () => app.toggleUnreadOnly() },
      { id: "agent", label: "Open Tern agent", group: "Actions", hint: "^J", run: () => app.toggleAgent(true) },
      { id: "settings", label: "Settings", group: "App", hint: "^,", run: () => app.openSettings() },
      { id: "settings-ai", label: "Settings: AI providers", group: "App", run: () => app.openSettings("ai") },
      { id: "settings-acc", label: "Settings: Add account", group: "App", run: () => app.openSettings("accounts") },
      { id: "settings-look", label: "Settings: Appearance", group: "App", run: () => app.openSettings("appearance") },
      { id: "keys", label: "Keyboard shortcuts", group: "App", hint: "?", run: () => (app.cheatsheetOpen = true) },
      { id: "today", label: "Go to Today", group: "Go to", hint: "g t", run: go({ kind: "today" }) },
      { id: "calendar", label: "Go to Calendar", group: "Go to", hint: "g c", run: go({ kind: "calendar" }) },
      { id: "cal-day", label: "Calendar: Day view", group: "Go to", hint: "d", run: () => { app.setView({ kind: "calendar" }); calendar.setView("day"); } },
      { id: "cal-week", label: "Calendar: Week view", group: "Go to", hint: "w", run: () => { app.setView({ kind: "calendar" }); calendar.setView("week"); } },
      { id: "cal-month", label: "Calendar: Month view", group: "Go to", hint: "m", run: () => { app.setView({ kind: "calendar" }); calendar.setView("month"); } },
      { id: "cal-agenda", label: "Calendar: Agenda", group: "Go to", hint: "a", run: () => { app.setView({ kind: "calendar" }); calendar.setView("agenda"); } },
      { id: "settings-cal", label: "Settings: Calendar", group: "App", run: () => app.openSettings("calendar") },
      { id: "cal-insights", label: "Calendar: Insights", group: "Go to", hint: "i", run: () => { app.setView({ kind: "calendar" }); calendar.setView("insights"); } },
      { id: "join", label: "Join the current / next meeting", group: "Actions", hint: "g j", run: () => calendar.joinNext() },
      { id: "snoozed", label: "Go to Snoozed", group: "Go to", hint: "g z", run: go({ kind: "snoozed" }) },
      { id: "snooze", label: "Snooze selected message", group: "Actions", hint: "z", run: () => app.openSnooze() },
      { id: "availability", label: "Share my availability by email", group: "Actions", run: () => calendar.shareAvailability() },
      { id: "new-event", label: "New event", group: "Actions", hint: "n", run: () => calendar.openComposer() },
      ...(app.aiReady ? [{ id: "find-time", label: "Find a time with…", group: "Actions", run: () => { app.toggleAgent(true); findTimePrefill(); } }] : []),
      { id: "flagged", label: "Go to Flagged", group: "Go to", run: go({ kind: "flagged" }) },
    ];
    const wks: WellKnownFolder[] = ["inbox", "drafts", "sentitems", "archive", "deleteditems", "junkemail"];
    for (const wk of wks) cmds.push({ id: `wk-${wk}`, label: `Go to ${wkLabel(wk)}`, group: "Go to", run: go({ kind: "unified", wellKnown: wk }) });
    for (const c of SMART_CATEGORIES)
      cmds.push({ id: `cat-${c}`, label: `Smart: ${CATEGORY_META[c].label}`, group: "Go to", run: go({ kind: "category", category: c }) });
    for (const f of app.folders.filter((f) => !f.wellKnown)) {
      const acct = app.accountById.get(f.accountId);
      cmds.push({
        id: `f-${f.id}`,
        label: `Folder: ${f.name}`,
        group: "Go to",
        hint: app.accounts.length > 1 ? acct?.email : undefined,
        run: go({ kind: "folder", folderId: f.id }),
      });
    }
    for (const a of app.accounts)
      cmds.push({ id: `acct-${a.id}`, label: `Only show ${a.email}`, group: "Accounts", run: () => app.setAccountFilter(a.id) });
    if (app.accountFilter) cmds.push({ id: "acct-all", label: "Show all accounts", group: "Accounts", run: () => app.setAccountFilter(null) });
    if (app.open) {
      const m = app.open;
      cmds.push(
        { id: "reply", label: "Reply", group: "Message", hint: "r", run: () => composer.reply(m, "reply") },
        { id: "replyall", label: "Reply all", group: "Message", hint: "R", run: () => composer.reply(m, "replyAll") },
        { id: "fwd", label: "Forward", group: "Message", hint: "f", run: () => composer.reply(m, "forward") },
        { id: "arch", label: "Archive", group: "Message", hint: "e", run: () => app.archive([m.id]) },
        { id: "del", label: "Delete", group: "Message", hint: "#", run: () => app.trash([m.id]) },
      );
    }
    return cmds;
  });

  const results = $derived.by(() => {
    const query = q.trim();
    const scored = commands
      .map((c) => ({ c, s: query ? fuzzyScore(query, c.label) : 0 }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
    const out: Cmd[] = [];
    if (query) {
      if (app.aiReady)
        out.push({ id: "ask", label: `Ask Tern: “${query}”`, group: "Tern", hint: "↵", run: () => agent.send(query) });
      out.push({ id: "search", label: `Search mail for “${query}”`, group: "Tern", run: () => app.search(query) });
    }
    // With a query, put the best command first unless nothing matched well.
    return query && scored.length && fuzzyScore(query, scored[0].label) > 900 ? [...scored, ...out] : [...out, ...scored];
  });

  $effect(() => {
    void q;
    active = 0;
  });

  function run(c: Cmd | undefined) {
    if (!c) return;
    app.paletteOpen = false;
    c.run();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      scrollActive();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      active = Math.max(0, active - 1);
      scrollActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active]);
    }
  }

  function scrollActive() {
    tick().then(() => listEl?.querySelector(".active")?.scrollIntoView({ block: "nearest" }));
  }
</script>

{#if app.paletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => (app.paletteOpen = false)}>
    <div class="palette" onclick={(e) => e.stopPropagation()}>
      <div class="in">
        <Search size={16} />
        <input bind:this={input} bind:value={q} {onkeydown} placeholder="Type a command, a folder, or ask Tern…" spellcheck="false" />
        <kbd>esc</kbd>
      </div>
      <div class="results" bind:this={listEl}>
        {#each results as c, i (c.id)}
          {#if i === 0 || results[i - 1].group !== c.group}
            <div class="group eyebrow">{c.group}</div>
          {/if}
          <button class="item" class:active={i === active} onmousemove={() => (active = i)} onclick={() => run(c)}>
            {#if c.id === "ask"}<Sparkles size={14} class="ask-ic" />{/if}
            <span class="label">{c.label}</span>
            {#if c.hint}<span class="hint">{c.hint}</span>{/if}
            {#if i === active}<CornerDownLeft size={13} class="enter" />{/if}
          </button>
        {:else}
          <div class="none">No matches</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: color-mix(in oklab, var(--bg-darker) 45%, transparent);
    animation: fade 120ms;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .palette {
    width: min(620px, calc(100vw - 40px));
    border-radius: 16px;
    background: color-mix(in oklab, var(--bg-lighter) 60%, var(--bg));
    box-shadow: var(--shadow);
    overflow: hidden;
    animation: pop 160ms var(--ease);
  }
  @keyframes pop {
    from {
      transform: scale(0.98) translateY(-6px);
      opacity: 0;
    }
  }
  .in {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 54px;
    padding: 0 16px 0 18px;
    border-bottom: 1px solid var(--line);
    color: var(--accent);
  }
  .in input {
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    font-size: 15px;
  }
  .in input::placeholder {
    color: var(--muted);
  }
  .results {
    max-height: min(420px, 60vh);
    overflow-y: auto;
    padding: 6px;
  }
  .group {
    padding: 10px 12px 4px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 36px;
    padding: 0 12px;
    border-radius: 8px;
    text-align: left;
    font-size: 13px;
    color: var(--fg-dim);
  }
  .item.active {
    background: var(--active);
    color: var(--fg-bright);
  }
  .item :global(.ask-ic) {
    color: var(--accent);
  }
  .label {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .hint {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }
  .item :global(.enter) {
    color: var(--accent);
  }
  .none {
    padding: 20px;
    text-align: center;
    color: var(--muted);
  }
</style>
