<script lang="ts">
  // Today: briefing + proactive cards. Replaces list + reader while active.
  import { app } from "$lib/state/app.svelte";
  import { today } from "$lib/state/today.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { agent } from "$lib/state/agent.svelte";
  import { api } from "$lib/api";
  import { draftReply } from "$lib/ai";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { displayName } from "$lib/util/misc";
  import { relative, shortTime } from "$lib/util/time";
  import type { MessageSummary } from "$lib/types";
  import Avatar from "./Avatar.svelte";
  import DraftCard from "./DraftCard.svelte";
  import Logo from "./Logo.svelte";
  import {
    Sparkles,
    RotateCcw,
    LoaderCircle,
    Archive,
    ArrowRight,
    Clock,
    CalendarClock,
    Send,
    Hourglass,
    MessageSquareReply,
    X,
    Paperclip,
  } from "@lucide/svelte";

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  // Only greet by name when the primary account's display name looks like a person (two+ words),
  // not a company label like "Emcap".
  const firstName = $derived.by(() => {
    const n = (app.accounts[0]?.displayName || "").trim();
    return /\s/.test(n) ? n.split(/\s+/)[0] : "";
  });
  const dateLine = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  // Load whenever the view becomes active (reload() also triggers it after sync).
  $effect(() => {
    if (app.view.kind === "today" && !today.loadedOnce) today.load();
  });

  const stats = $derived.by(() => {
    const parts: string[] = [];
    parts.push(`${today.unreadCount} unread`);
    if (today.needsReply.length) parts.push(`${today.needsReply.length} need${today.needsReply.length === 1 ? "s" : ""} a reply`);
    if (today.visibleWaiting.length) parts.push(`${today.visibleWaiting.length} waiting on others`);
    if (today.overdue.length) parts.push(`${today.overdue.length} overdue`);
    return parts.join(" · ");
  });

  const QUICK = [
    "What's the most urgent thing right now?",
    "Summarize what I missed since yesterday",
    "Archive all newsletters older than a week",
    "Draft replies to anything still waiting on me",
  ];

  function ask(q: string) {
    app.toggleAgent(true);
    agent.send(q);
  }

  function openMsg(m: MessageSummary) {
    app.select(m.id);
  }

  async function nudge(m: MessageSummary) {
    const acct = app.accountById.get(m.accountId);
    if (!acct) return;
    const full = await api.message(m.id);
    composer.reply(full, "replyAll");
    if (app.aiReady) {
      composer.streamBody((signal) =>
        draftReply({
          message: full,
          instruction: "Write a short, friendly follow-up nudge asking for an update on my previous email below. Two or three sentences, no pressure.",
          account: acct,
          signal,
        }),
      );
    }
  }

  function daysAgo(iso: string): string {
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  }

  function dueLabel(iso: string): string {
    const d = new Date(iso);
    const hasTime = /T\d{2}:\d{2}/.test(iso) && !/T00:00(:00)?/.test(iso);
    return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + (hasTime ? ` · ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "");
  }

  const dueGroups = $derived.by<{ label: string; items: MessageSummary[] }[]>(() => [
    { label: "Overdue", items: today.overdue },
    { label: "Today", items: today.dueToday },
    { label: "This week", items: today.dueWeek },
  ]);

  function recipients(m: MessageSummary): string {
    const names = m.to.map((a) => displayName(a).split(/\s+/)[0]);
    return names.length <= 2 ? names.join(" and ") : `${names[0]} +${names.length - 1}`;
  }
</script>

<section class="today">
  <div class="scroll">
    <div class="canvas">
      <header class="hero">
        <div>
          <div class="date eyebrow">{dateLine}</div>
          <h1>{greeting}{firstName ? `, ${firstName}` : ""}.</h1>
          <div class="stats">
            {#if today.loading && !today.loadedOnce}
              <span class="shimmer-text">Looking at your mail…</span>
            {:else}
              {stats}
              {#if app.triaging}<span class="dot-sep">·</span><span class="shimmer-text">Triaging…</span>{/if}
              {#if today.predraftRunning}<span class="dot-sep">·</span><span class="shimmer-text">Drafting replies…</span>{/if}
            {/if}
          </div>
        </div>
        <div class="hero-mark"><Logo size={44} /></div>
      </header>

      <!-- Briefing -->
      <div class="card briefing" class:busy={today.briefingBusy}>
        <div class="card-head">
          <span class="spark"><Sparkles size={13} /></span>
          <span class="eyebrow accent">Briefing</span>
          <span class="spacer"></span>
          {#if app.aiReady}
            {#if today.briefingBusy}
              <LoaderCircle size={13} class="spin muted" />
            {:else}
              {#if today.briefingAt}<span class="when">{relative(new Date(today.briefingAt).toISOString())}</span>{/if}
              <button class="mini" onclick={() => today.refreshBriefing()} title="Refresh briefing"><RotateCcw size={12} /> Refresh</button>
            {/if}
          {/if}
        </div>
        {#if !app.aiReady}
          <div class="setup">
            <p>Connect Claude or any OpenAI-compatible model and Tern will write you a briefing of what matters, draft replies ahead of time, and tell you who's waiting on you.</p>
            <button class="btn primary" onclick={() => app.openSettings("ai")}>Set up AI <ArrowRight size={14} /></button>
          </div>
        {:else if today.briefingText}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="md brief" onclick={mdLinkHandler}>{@html md(today.briefingText)}</div>
        {:else if today.briefingBusy}
          <div class="skeleton">
            <span style:width="70%"></span><span style:width="95%"></span><span style:width="88%"></span><span style:width="52%"></span>
          </div>
        {:else if today.briefingError}
          <div class="err">{today.briefingError} <button class="link" onclick={() => today.refreshBriefing()}>Try again</button></div>
        {:else}
          <div class="skeleton">
            <span style:width="70%"></span><span style:width="95%"></span>
          </div>
        {/if}
      </div>

      {#if app.aiReady}
        <div class="quick">
          {#each QUICK as q}
            <button class="qchip" onclick={() => ask(q)}><Sparkles size={11} />{q}</button>
          {/each}
        </div>
      {/if}

      {#if today.calm}
        <div class="calm">
          <div class="calm-art" aria-hidden="true">
            <span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>
            <Logo size={56} />
          </div>
          <h2>Inbox is calm</h2>
          <p>Nothing needs a reply, nobody's waiting on you, and nothing is due. Enjoy it.</p>
          <button class="btn" onclick={() => app.setView({ kind: "unified", wellKnown: "inbox" })}>Browse inbox <ArrowRight size={14} /></button>
        </div>
      {/if}

      <!-- Needs your reply -->
      {#if today.needsReply.length}
        <section class="group">
          <div class="group-head">
            <MessageSquareReply size={14} />
            <h2>Needs your reply</h2>
            <span class="n">{today.needsReply.length}</span>
            <span class="spacer"></span>
            <button class="mini" onclick={() => app.setView({ kind: "category", category: "needs_reply" })}>See all <ArrowRight size={12} /></button>
          </div>
          <div class="cards" class:single={today.needsReply.length <= 2}>
            {#each today.needsReply as m, i (m.id)}
              <article class="card reply" class:unread={!m.isRead} style:--i={i}>
                <div class="row">
                  <Avatar addr={m.from} size={34} />
                  <div class="who">
                    <div class="l1">
                      <span class="name">{displayName(m.from)}</span>
                      {#if m.ai?.priority === 3}<span class="chip prio">High</span>{/if}
                      {#if m.hasAttachments}<Paperclip size={11} class="muted" />{/if}
                      <span class="spacer"></span>
                      <time class="mono">{shortTime(m.receivedAt)}</time>
                    </div>
                    <button class="subject" onclick={() => openMsg(m)}>{m.subject || "(no subject)"}</button>
                    {#if m.ai?.summary}<div class="summary">{m.ai.summary}</div>{/if}
                  </div>
                </div>
                {#if app.aiReady}<DraftCard message={m} compact />{/if}
                <div class="card-actions">
                  <button class="mini" onclick={() => openMsg(m)}>Open <ArrowRight size={12} /></button>
                  <button class="mini" onclick={() => app.archive([m.id]).then(() => today.load({ silent: true }))}><Archive size={12} /> Archive</button>
                </div>
              </article>
            {/each}
          </div>
        </section>
      {/if}

      <div class="two">
        <!-- Waiting on others -->
        {#if today.visibleWaiting.length}
          <section class="group">
            <div class="group-head">
              <Hourglass size={14} />
              <h2>Waiting on others</h2>
              <span class="n">{today.visibleWaiting.length}</span>
            </div>
            <div class="list">
              {#each today.visibleWaiting as m, i (m.id)}
                <div class="item" style:--i={i}>
                  <Avatar addr={m.to[0] ?? m.from} size={30} />
                  <div class="it">
                    <div class="it1">You wrote to <b>{recipients(m)}</b> <span class="muted">{daysAgo(m.receivedAt)}</span></div>
                    <button class="it2" onclick={() => openMsg(m)}>{m.subject || "(no subject)"}</button>
                  </div>
                  <div class="it-actions">
                    <button class="btn sm" onclick={() => nudge(m)} title="Draft a friendly follow-up"><Send size={12} /> Nudge</button>
                    <button class="icon-btn s" title="Dismiss" aria-label="Dismiss" onclick={() => today.dismiss(m.id)}><X size={13} /></button>
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- Deadlines -->
        {#if today.due.length}
          <section class="group">
            <div class="group-head">
              <CalendarClock size={14} />
              <h2>Deadlines</h2>
              <span class="n">{today.due.length}</span>
            </div>
            <div class="list">
              {#each dueGroups as { label, items } (label)}
                {#if items.length}
                  <div class="sub eyebrow" class:late={label === "Overdue"}>{label}</div>
                  {#each items as m, i (m.id)}
                    <div class="item" style:--i={i}>
                      <span class="due-ic" class:late={label === "Overdue"}><Clock size={13} /></span>
                      <div class="it">
                        <div class="it1"><b>{dueLabel(m.ai!.dueAt!)}</b> <span class="muted">· {displayName(m.from)}</span></div>
                        <button class="it2" onclick={() => openMsg(m)}>{m.ai?.summary ?? m.subject}</button>
                      </div>
                      <div class="it-actions">
                        <button class="mini" onclick={() => openMsg(m)}>Open <ArrowRight size={12} /></button>
                      </div>
                    </div>
                  {/each}
                {/if}
              {/each}
            </div>
          </section>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .today {
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(900px 400px at 85% -10%, color-mix(in oklab, var(--accent) 9%, transparent), transparent 70%),
      var(--surface);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  .canvas {
    max-width: 920px;
    margin: 0 auto;
    padding: 28px 40px 80px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 4px 4px;
    animation: fade-up 240ms var(--ease);
  }
  .date {
    margin-bottom: 8px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    line-height: 1.15;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--fg-bright);
  }
  .stats {
    margin-top: 8px;
    font-size: 13px;
    color: var(--fg-dim);
  }
  .dot-sep {
    margin: 0 6px;
    color: var(--muted);
  }
  .hero-mark {
    opacity: 0.8;
    filter: drop-shadow(0 6px 18px rgba(var(--accent-rgb), 0.35));
  }

  .card {
    padding: 16px 18px;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    animation: fade-up 240ms var(--ease) both;
    animation-delay: calc(var(--i, 0) * 40ms);
  }
  .briefing {
    background:
      linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, transparent), transparent 60%),
      color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 20%, var(--line));
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spark {
    display: grid;
    color: var(--accent);
  }
  .eyebrow.accent {
    color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .when {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--font-mono);
  }
  .mini {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--fg-dim);
    padding: 3px 8px;
    border-radius: 6px;
    transition: all var(--t);
  }
  .mini:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .brief {
    margin-top: 10px;
    font-size: 13.5px;
    line-height: 1.6;
  }
  .brief :global(p:first-child) {
    font-size: 15px;
    line-height: 1.45;
    margin-bottom: 0.7em;
  }
  .brief :global(p:first-child strong) {
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .brief :global(p > strong:only-child) {
    display: inline-block;
    margin-top: 0.4em;
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .brief :global(p:first-child > strong:only-child) {
    display: inline;
    margin: 0;
    font-size: inherit;
    letter-spacing: -0.01em;
    text-transform: none;
    color: var(--fg-bright);
  }
  .setup {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-top: 8px;
  }
  .setup p {
    flex: 1;
    margin: 0;
    color: var(--fg-dim);
    font-size: 13px;
    line-height: 1.55;
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 14px;
  }
  .skeleton span {
    height: 11px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--hover) 25%, color-mix(in oklab, var(--accent) 14%, transparent) 50%, var(--hover) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }
  .err {
    margin-top: 8px;
    font-size: 12.5px;
    color: var(--red);
  }
  .link {
    color: var(--accent);
    font-weight: 600;
    margin-left: 6px;
  }

  .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: -8px;
  }
  .qchip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--fg-dim);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: all var(--t);
  }
  .qchip :global(svg) {
    color: var(--accent);
  }
  .qchip:hover {
    color: var(--fg);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px;
    color: var(--fg-dim);
  }
  .group-head h2 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--fg-bright);
  }
  .group-head .n {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
  }
  .cards.single {
    grid-template-columns: minmax(0, 1fr);
  }
  /* an odd last card spans the row so the grid never leaves a hole */
  .cards:not(.single) > .card:last-child:nth-child(odd) {
    grid-column: 1 / -1;
  }
  .card.reply {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
  }
  .card.reply.unread {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 22%, var(--line));
  }
  .row {
    display: flex;
    gap: 12px;
    min-width: 0;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .l1 {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .name {
    font-weight: 620;
    color: var(--fg-bright);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .l1 time {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .chip.prio {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 14%, transparent);
    height: 18px;
    font-size: 10px;
  }
  .subject {
    text-align: left;
    font-size: 13.5px;
    font-weight: 550;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subject:hover {
    color: var(--accent);
  }
  .summary {
    font-size: 12.5px;
    color: color-mix(in oklab, var(--fg-dim) 85%, var(--accent));
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .card-actions {
    display: flex;
    gap: 4px;
    margin: -4px -6px -6px;
  }

  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
    gap: 20px;
    align-items: start;
  }
  .list {
    display: flex;
    flex-direction: column;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 42%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    overflow: hidden;
  }
  .sub {
    padding: 10px 14px 4px;
  }
  .sub.late {
    color: var(--red);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    animation: fade-up 220ms var(--ease) both;
    animation-delay: calc(var(--i, 0) * 30ms);
    transition: background var(--t);
  }
  .item + .item {
    box-shadow: inset 0 1px 0 var(--line);
  }
  .item:hover {
    background: var(--hover);
  }
  .it {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .it1 {
    font-size: 12.5px;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .it1 b {
    color: var(--fg-bright);
    font-weight: 620;
  }
  .it2 {
    text-align: left;
    font-size: 13px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .it2:hover {
    color: var(--accent);
  }
  .muted,
  :global(.today .muted) {
    color: var(--muted);
  }
  .it-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .icon-btn.s {
    width: 26px;
    height: 26px;
  }
  .due-ic {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    flex: none;
    color: var(--yellow);
    background: color-mix(in oklab, var(--yellow) 14%, transparent);
  }
  .due-ic.late {
    color: var(--red);
    background: color-mix(in oklab, var(--red) 14%, transparent);
  }

  .calm {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
    padding: 44px 20px 36px;
    animation: fade-up 300ms var(--ease);
  }
  .calm-art {
    position: relative;
    display: grid;
    place-items: center;
    width: 140px;
    height: 140px;
    margin-bottom: 8px;
  }
  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent);
    animation: ripple 4.5s ease-out infinite;
  }
  .ring.r2 {
    animation-delay: 1.5s;
  }
  .ring.r3 {
    animation-delay: 3s;
  }
  @keyframes ripple {
    from {
      transform: scale(0.35);
      opacity: 0.9;
    }
    to {
      transform: scale(1);
      opacity: 0;
    }
  }
  .calm h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 680;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
  }
  .calm p {
    margin: 0 0 10px;
    color: var(--fg-dim);
    font-size: 13.5px;
    max-width: 380px;
  }

  @media (max-width: 1000px) {
    .canvas {
      padding: 22px 22px 60px;
    }
    .cards,
    .two {
      grid-template-columns: 1fr;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .item,
    .hero,
    .calm,
    .ring,
    .skeleton span {
      animation: none;
    }
  }
</style>
