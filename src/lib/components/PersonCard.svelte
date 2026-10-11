<script lang="ts">
  // Person card: click a name in the reader and see your whole relationship with them — from mail and
  // calendar already on this machine — plus the things you can do next. AI only when you ask for it.
  import { app } from "$lib/state/app.svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { connect } from "$lib/state/connect.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { api } from "$lib/api";
  import { personBrief } from "$lib/ai";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { errMsg, displayName } from "$lib/util/misc";
  import { shortTime, relative } from "$lib/util/time";
  import { monthYear, weekdayDayMonth, hhmm } from "$lib/util/fmt";
  import type { CalEvent, MessageSummary, PersonSummary } from "$lib/types";
  import Avatar from "./Avatar.svelte";
  import { X, PenLine, CalendarSearch, MessageCircle, Mails, Sparkles, LoaderCircle, CalendarDays, ArrowUpRight, ArrowDownLeft, Archive, Copy, Square } from "@lucide/svelte";

  const addr = $derived(app.person);
  const email = $derived(addr?.email.toLowerCase() ?? "");
  const domain = $derived(email.split("@")[1] ?? "");

  let summary = $state<PersonSummary | null>(null);
  let meetings = $state<CalEvent[]>([]);
  let loading = $state(false);
  let error = $state("");
  let brief = $state("");
  let briefBusy = $state(false);
  let briefCtrl: AbortController | null = null;
  let seq = 0;

  const name = $derived(summary?.name || addr?.name || "");
  const connectAccount = $derived(app.ownAccounts.find((a) => a.connectConsent));
  const inboxFromThem = $derived(app.messages.filter((m) => m.from.email.toLowerCase() === email));

  $effect(() => {
    const e = email;
    briefCtrl?.abort();
    brief = "";
    briefBusy = false;
    summary = null;
    meetings = [];
    error = "";
    if (!e) return;
    const mine = ++seq;
    loading = true;
    (async () => {
      try {
        const now = new Date();
        const to = new Date(now.getTime() + 60 * 86_400_000);
        const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00:00`;
        const [p, evs] = await Promise.all([
          api.person(e, 8),
          api.calendarEvents(iso(now), iso(to)).catch(() => [] as CalEvent[]),
        ]);
        if (mine !== seq) return;
        summary = p;
        const together = (ev: CalEvent) =>
          !ev.isCancelled &&
          ev.response !== "declined" &&
          new Date(ev.end).getTime() > Date.now() &&
          (ev.organizer?.email.toLowerCase() === e || ev.attendees.some((a) => a.addr.email.toLowerCase() === e));
        meetings = evs.filter(together).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4);
      } catch (err) {
        if (mine === seq) error = errMsg(err);
      } finally {
        if (mine === seq) loading = false;
      }
    })();
  });

  function close() {
    briefCtrl?.abort();
    app.person = null;
  }

  function openMail(m: MessageSummary) {
    app.select(m.id);
    if (!app.readingPane) void app.openInWindow(m.id);
  }

  function compose() {
    if (!addr) return;
    composer.compose({ to: [{ name, email: addr.email }], accountId: app.defaultMailAccount() });
  }

  function findTime() {
    app.agentPrefill = `Find 30 min with ${name ? `${name} <${email}>` : email} in the next week`;
    app.toggleAgent(true);
  }

  function chat() {
    if (!connectAccount) return;
    connect.show({ accountId: connectAccount.id, recipient: email });
  }

  function allMail() {
    app.search(`from:${email}`);
    close();
  }

  function jump(ev: CalEvent) {
    app.setView({ kind: "calendar" });
    calendar.jumpTo(ev);
    close();
  }

  async function archiveAll() {
    try {
      const list = await api.messages({ view: { kind: "unified", wellKnown: "inbox" }, limit: 500 });
      const ids = list.filter((m) => m.from.email.toLowerCase() === email).map((m) => m.id);
      if (!ids.length) return toasts.show("Nothing from them in the inbox", { kind: "success" });
      await app.archive(ids);
    } catch (e) {
      toasts.error(errMsg(e));
    }
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(email);
      toasts.show("Address copied", { kind: "success", timeout: 1500 });
    } catch {}
  }

  async function runBrief() {
    if (!summary || briefBusy) return;
    briefCtrl?.abort();
    const ctrl = new AbortController();
    briefCtrl = ctrl;
    briefBusy = true;
    brief = "";
    try {
      for await (const d of personBrief({ email, name, received: summary.recent, waiting: summary.waiting, meetings, signal: ctrl.signal })) {
        if (ctrl.signal.aborted) break;
        brief += d;
      }
    } catch (e) {
      if (!ctrl.signal.aborted) toasts.error(errMsg(e));
    } finally {
      if (briefCtrl === ctrl) briefBusy = false;
    }
  }

  function stopBrief() {
    briefCtrl?.abort();
    briefBusy = false;
  }
</script>

{#if addr}
  <aside class="card" aria-label="Person" data-person>
    <header>
      <Avatar addr={{ name, email }} size={44} />
      <div class="who">
        <div class="name">{name || email}</div>
        {#if name}<button class="email" title="Copy address" onclick={copyEmail}>{email} <Copy size={11} /></button>{:else}<span class="email muted">{domain}</span>{/if}
      </div>
      <button class="icon-btn" aria-label="Close" title="Close (Esc)" onclick={close}><X size={15} /></button>
    </header>

    <div class="actions">
      <button class="btn sm" onclick={compose}><PenLine size={13} /> Email</button>
      {#if app.aiReady}<button class="btn sm" onclick={findTime}><CalendarSearch size={13} /> Find a time</button>{/if}
      {#if connectAccount}<button class="btn sm" onclick={chat}><MessageCircle size={13} /> Chat</button>{/if}
      <button class="btn sm" onclick={allMail}><Mails size={13} /> All mail</button>
    </div>

    <div class="scroll">
      {#if loading && !summary}
        <div class="loading"><LoaderCircle size={15} class="spin" /></div>
      {:else if error}
        <p class="err">{error}</p>
      {:else if summary}
        <div class="stats">
          <span><b>{summary.received}</b> received</span>
          <span><b>{summary.sent}</b> sent</span>
          {#if summary.firstAt}<span>since <b>{monthYear(summary.firstAt)}</b></span>{/if}
          {#if summary.lastAt}<span>last <b>{relative(summary.lastAt)}</b></span>{/if}
        </div>

        {#if app.aiReady}
          <section class="brief" class:on={brief || briefBusy}>
            {#if !brief && !briefBusy}
              <button class="brief-btn" onclick={runBrief}><Sparkles size={13} /> Brief me on {name ? name.split(" ")[0] : "them"}</button>
            {:else}
              <div class="brief-head">
                <span class="eyebrow"><Sparkles size={12} /> Tern</span>
                {#if briefBusy}
                  <button class="mini" onclick={stopBrief}><Square size={10} fill="currentColor" /> Stop</button>
                {:else}
                  <button class="mini" onclick={runBrief}>Again</button>
                {/if}
              </div>
              {#if brief}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class="md body" onclick={mdLinkHandler}>{@html md(brief)}</div>
              {:else}
                <div class="shimmer-text">Reading your history together…</div>
              {/if}
            {/if}
          </section>
        {/if}

        {#if summary.unanswered.length}
          <section>
            <h3>Waiting on you <span>{summary.unanswered.length}</span></h3>
            {#each summary.unanswered as m (m.id)}
              <button class="row" onclick={() => openMail(m)}>
                <ArrowDownLeft size={12} class="dir in" />
                <span class="subj">{m.subject || "(no subject)"}</span>
                <time class="mono">{shortTime(m.receivedAt)}</time>
              </button>
            {/each}
          </section>
        {/if}

        {#if summary.waiting.length}
          <section>
            <h3>Waiting on them <span>{summary.waiting.length}</span></h3>
            {#each summary.waiting as m (m.id)}
              <button class="row" onclick={() => openMail(m)}>
                <ArrowUpRight size={12} class="dir out" />
                <span class="subj">{m.subject || "(no subject)"}</span>
                <time class="mono">{shortTime(m.receivedAt)}</time>
              </button>
            {/each}
          </section>
        {/if}

        {#if meetings.length}
          <section>
            <h3>Meetings together</h3>
            {#each meetings as ev (ev.id)}
              <button class="row" onclick={() => jump(ev)}>
                <CalendarDays size={12} class="dir cal" />
                <span class="subj">{ev.subject || "(no title)"}</span>
                <time class="mono">{weekdayDayMonth(ev.start)}{ev.isAllDay ? "" : ` ${hhmm(ev.start)}`}</time>
              </button>
            {/each}
          </section>
        {/if}

        <section>
          <h3>Recent from {name ? name.split(" ")[0] : "them"}</h3>
          {#each summary.recent as m (m.id)}
            <button class="row" class:unread={!m.isRead} onclick={() => openMail(m)}>
              <span class="dot" class:on={!m.isRead}></span>
              <span class="subj">{m.subject || "(no subject)"}</span>
              <time class="mono">{shortTime(m.receivedAt)}</time>
            </button>
          {:else}
            <p class="muted">No mail from them yet.</p>
          {/each}
        </section>

        {#if inboxFromThem.length > 1 && app.view.kind === "unified" && app.view.wellKnown === "inbox"}
          <section>
            <button class="row sweep" onclick={archiveAll}><Archive size={12} class="dir" /><span class="subj">Archive everything from them in the inbox</span></button>
          </section>
        {/if}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .card {
    position: fixed;
    top: 56px;
    right: 10px;
    bottom: 10px;
    z-index: 46;
    width: min(400px, calc(100vw - 20px));
    display: flex;
    flex-direction: column;
    border-radius: 14px;
    background: color-mix(in oklab, var(--bg-lighter) 55%, var(--bg));
    box-shadow: var(--shadow);
    animation: slide 200ms var(--ease);
  }
  @keyframes slide {
    from {
      transform: translateX(16px);
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 12px 10px 16px;
  }
  .who {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-size: 15px;
    font-weight: 660;
    color: var(--fg-bright);
    letter-spacing: -0.01em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .email {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    user-select: text;
  }
  button.email:hover {
    color: var(--fg);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 16px 12px;
    border-bottom: 1px solid var(--line);
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 6px 10px 16px;
  }
  .loading {
    display: grid;
    place-items: center;
    padding: 40px;
    color: var(--muted);
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 8px 6px 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .stats b {
    color: var(--fg);
    font-weight: 600;
  }
  section {
    padding: 10px 0 4px;
  }
  h3 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 6px 4px;
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h3 span {
    color: var(--accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 30px;
    padding: 0 8px;
    border-radius: 7px;
    text-align: left;
    font-size: 12.5px;
    color: var(--fg-dim);
  }
  .row:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .row.unread {
    color: var(--fg);
    font-weight: 550;
  }
  .row :global(.dir) {
    flex: none;
    color: var(--muted);
  }
  .row :global(.dir.in) {
    color: var(--accent);
  }
  .row :global(.dir.out) {
    color: var(--orange);
  }
  .row :global(.dir.cal) {
    color: var(--blue);
  }
  .dot {
    width: 6px;
    height: 6px;
    margin: 0 3px;
    border-radius: 50%;
    flex: none;
    background: transparent;
  }
  .dot.on {
    background: var(--accent);
  }
  .subj {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .row time {
    font-size: 10.5px;
    color: var(--muted);
    flex: none;
  }
  .sweep {
    color: var(--muted);
    font-size: 12px;
  }
  .muted {
    margin: 0 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .err {
    margin: 12px 8px;
    font-size: 12px;
    color: var(--red);
  }
  .brief {
    margin: 8px 0 2px;
    padding: 0 6px;
  }
  .brief.on {
    padding: 10px 12px;
    border-radius: var(--r-lg);
    background:
      linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, transparent), transparent 60%),
      color-mix(in oklab, var(--bg-lighter) 45%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 16%, var(--line));
    animation: fade-up 200ms var(--ease);
  }
  .brief-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 2px;
    font-size: 12.5px;
    color: var(--accent);
  }
  .brief-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--accent);
  }
  .brief-head .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
  }
  .mini {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--fg-dim);
    padding: 2px 7px;
    border-radius: 6px;
  }
  .mini:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .brief .body {
    margin-top: 6px;
    font-size: 12.5px;
    color: var(--fg);
  }
  .brief .shimmer-text {
    margin-top: 6px;
    font-size: 12.5px;
  }
</style>
