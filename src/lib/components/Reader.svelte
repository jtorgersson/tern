<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { connect } from "$lib/state/connect.svelte";
  import { MessageCircle } from "@lucide/svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { api } from "$lib/api";
  import { hueColor } from "$lib/theme";
  import { longTime, shortTime } from "$lib/util/time";
  import { displayName, errMsg } from "$lib/util/misc";
  import type { Addr, MessageFull } from "$lib/types";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import Avatar from "./Avatar.svelte";
  import MailFrame, { type HoverLink } from "./MailFrame.svelte";
  import AttachmentCard from "./AttachmentCard.svelte";
  import TldrCard from "./TldrCard.svelte";
  import QuickReply from "./QuickReply.svelte";
  import InviteCard from "./InviteCard.svelte";
  import DateChips from "./DateChips.svelte";
  import Logo from "./Logo.svelte";
  import MessageStatus from "./MessageStatus.svelte";
  import {
    Archive,
    Trash2,
    Star,
    MailOpen,
    Reply,
    ReplyAll,
    Forward,
    ExternalLink,
    LoaderCircle,
    AlarmClock,
    MailX,
    SquareArrowOutUpRight,
    X,
    ChevronUp,
    ArrowLeft,
    FolderInput,
    Link2,
    TriangleAlert,
    Ellipsis,
  } from "@lucide/svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { parseMailto } from "$lib/util/mailto";

  // ---- unsubscribe ----
  let unsubBusy = $state(false);
  let unsubDone = $state<string | null>(null);
  let showPeople = $state(false);
  let menu = $state(false);

  $effect(() => {
    void app.open?.id;
    unsubDone = null;
    hover = null;
    showPeople = false;
    menu = false;
  });

  $effect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".overflow")) menu = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      menu = false;
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  });
  async function unsubscribe(msg: MessageFull) {
    const u = msg.unsubscribe;
    if (!u) return;
    unsubBusy = true;
    try {
      if (u.oneClick) {
        await api.unsubscribeOneClick(msg.id);
        unsubDone = msg.id;
        offerCleanup(msg, `Unsubscribed from ${displayName(msg.from)}`);
      } else if (u.url) {
        await openUrl(u.url);
        offerCleanup(msg, "Opened the sender's unsubscribe page");
      } else if (u.mailto) {
        composer.compose({ ...parseMailto(u.mailto), accountId: msg.accountId });
      }
    } catch (e) {
      toasts.error(errMsg(e));
    } finally {
      unsubBusy = false;
    }
  }
  /** After unsubscribing, offer to archive everything else from that sender. */
  function offerCleanup(msg: MessageFull, text: string) {
    toasts.show(text, {
      kind: "success",
      timeout: 9000,
      action: {
        label: "Archive all from sender",
        run: async () => {
          const list = await api.messages({ view: { kind: "unified", wellKnown: "inbox" }, accountId: msg.accountId, limit: 500 });
          const ids = list.filter((x) => x.from.email.toLowerCase() === msg.from.email.toLowerCase()).map((x) => x.id);
          if (ids.length) app.archive(ids);
        },
      },
    });
  }

  const m = $derived(app.open);
  const acct = $derived(m ? app.accountById.get(m.accountId) : undefined);

  /** Thread sorted oldest → newest; the opened message is always included. */
  const thread = $derived.by(() => {
    if (!m) return [] as MessageFull[];
    const t = app.thread.length ? app.thread : [m];
    const list = t.some((x) => x.id === m.id) ? t : [...t, m];
    return [...list].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  });

  let expanded = $state<Set<string>>(new Set());
  const openedId = $derived(m?.id);
  $effect(() => {
    void openedId;
    expanded = new Set();
  });
  const associated = $derived(thread.filter(t => t.id !== m?.id));

  function toggle(id: string) {
    const s = new Set(expanded);
    if (s.has(id)) s.delete(id);
    else { s.add(id); void app.refreshResponse(id); }
    expanded = s;
  }

  function discussEmail(message: MessageFull) {
    const ownerId = app.accountById.get(message.accountId)?.ownerId || message.accountId;
    const me = app.accountById.get(ownerId)?.email.toLowerCase();
    const person = message.from.email.toLowerCase() === me ? message.to.find(a => a.email.toLowerCase() !== me) : message.from;
    connect.show({ accountId: ownerId, recipient: person?.email ?? "", draft:
      `About “${message.subject || "(no subject)"}”\n\n${message.bodyText.slice(0, 3000)}${message.webLink ? `\n\nEmail: ${message.webLink}` : ""}` });
  }

  // ---- link preview (hovering a link in the mail shows where it really goes) ----
  let hover = $state<HoverLink | null>(null);
  const hostOf = (s: string) => {
    try {
      return new URL(/^[a-z]+:/i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };
  /** The visible text names a site, but the link goes somewhere else. */
  const hoverMismatch = $derived.by(() => {
    if (!hover || !/^https?:/i.test(hover.href)) return false;
    const text = hover.text;
    if (!/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(text)) return false;
    const a = hostOf(text);
    const b = hostOf(hover.href);
    return !!a && !!b && a !== b && !b.endsWith(`.${a}`) && !a.endsWith(`.${b}`);
  });
  const hoverShown = $derived(hover ? hover.href.replace(/^mailto:/i, "✉ ").replace(/^tel:/i, "☎ ") : "");
</script>

{#snippet person(a: Addr)}
  <button class="person" onclick={() => app.showPerson(a)} title="Who is {a.email}? (opens the person card)">{displayName(a)}</button>
{/snippet}

{#snippet people(list: Addr[])}
  {#each list as a, i (a.email + i)}{#if i > 0}, {/if}{@render person(a)}{/each}
{/snippet}

{#snippet email(t: MessageFull, primary = false)}
  <div class="msg">
    <header class="msg-head">
      <button class="avatar-btn" onclick={() => app.showPerson(t.from)} aria-label="Who is {displayName(t.from)}?"><Avatar addr={t.from} size={38} /></button>
      <div class="who">
        <div class="line">
          <span class="name">{@render person(t.from)}</span>
          {#if primary}
            <button class="quiet" aria-expanded={showPeople} onclick={() => (showPeople = !showPeople)}>
              {#if showPeople}Hide details{:else}to {t.to.length === 0 ? "—" : t.to.length === 1 ? displayName(t.to[0]) : `${t.to.length} people`}{#if t.cc.length}, {t.cc.length} cc{/if}{/if}
            </button>
          {:else}
            <span class="email">{t.from.email}</span>
          {/if}
        </div>
        {#if primary && showPeople}
          <div class="line sub"><span class="email">{t.from.email}</span></div>
        {/if}
        {#if !primary || showPeople}
          <div class="line sub">
            <span>to {#if t.to.length}{@render people(t.to)}{:else}—{/if}</span>
            {#if t.cc.length}<span>· cc {@render people(t.cc)}</span>{/if}
          </div>
        {/if}
      </div>
      <div class="when">
        <MessageStatus message={t} compact />
        <time class="mono">{longTime(t.receivedAt)}</time>
      </div>
      {#if !primary}<button class="icon-btn" aria-label="Collapse related email" onclick={() => toggle(t.id)}><ChevronUp size={14} /></button>{/if}
    </header>

    <div class="content">
      <MailFrame html={t.bodyHtml} onlink={(l) => (hover = l)} />
    </div>
    {#if !t.meetingType || t.meetingType === "none"}
      <DateChips message={t} />
    {/if}

    {#if t.attachments.some((a) => !a.isInline)}
      <div class="atts">
        {#each t.attachments.filter((a) => !a.isInline) as a (a.id)}
          <AttachmentCard message={t} attachment={a} />
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<section class="reader">
  {#if m}
    <div class="toolbar" data-tauri-drag-region>
      {#if app.windowKind === "main"}<button class="btn ghost back-list" onclick={() => app.closeReader()}><ArrowLeft size={14} /> Back to messages</button>{/if}
      <div class="group">
        <button class="icon-btn" title="Archive (e)" onclick={() => app.archive([m.id])}><Archive size={16} /></button>
        <button class="icon-btn" title="Delete (#)" onclick={() => app.trash([m.id])}><Trash2 size={16} /></button>
        {#if m.snoozedUntil}
          <button class="icon-btn on" title="Snoozed — click to bring it back now" onclick={() => app.unsnooze([m.id])}><AlarmClock size={16} /></button>
        {:else}
          <button class="icon-btn" title="Snooze (z)" onclick={() => app.openSnooze([m.id])}><AlarmClock size={16} /></button>
        {/if}
        <button class="icon-btn" class:on={m.isFlagged} title="Flag (s)" onclick={() => app.toggleFlag([m.id])}>
          <Star size={16} fill={m.isFlagged ? "currentColor" : "none"} />
        </button>
      </div>
      <div class="group reply-group">
        <button class="icon-btn" title="Reply (r)" onclick={() => composer.reply(m, "reply")}><Reply size={16} /></button>
        <button class="icon-btn" title="Reply all (R)" onclick={() => composer.reply(m, "replyAll")}><ReplyAll size={16} /></button>
        <button class="icon-btn" title="Forward (f)" onclick={() => composer.reply(m, "forward")}><Forward size={16} /></button>
        <div class="overflow">
          <button class="icon-btn" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onclick={() => (menu = !menu)}><Ellipsis size={16} /></button>
          {#if menu}
            <div class="menu" role="menu">
              <button role="menuitem" onclick={() => { menu = false; app.openMove([m.id]); }}><FolderInput size={14} /> Move to folder</button>
              <button role="menuitem" onclick={() => { menu = false; app.setRead([m.id], false); }}><MailOpen size={14} /> Mark unread</button>
              {#if m.webLink}
                <button role="menuitem" onclick={() => { menu = false; openUrl(m.webLink!); }}><ExternalLink size={14} /> Open in Outlook</button>
              {/if}
              {#if app.windowKind === "main"}
                <button role="menuitem" onclick={() => { menu = false; discussEmail(m); }}><MessageCircle size={14} /> Discuss in Connect</button>
                <button role="menuitem" onclick={() => { menu = false; app.openInWindow(m.id); }}><SquareArrowOutUpRight size={14} /> Open in new window</button>
              {:else}
                <button role="menuitem" onclick={() => getCurrentWindow().close()}><X size={14} /> Close window</button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <div class="scroll">
      {#key m.id}
        <article>
          <h2 class="subject">{m.subject || "(no subject)"}</h2>
          <div class="meta-row">
            {#if acct && app.accounts.length > 1}
              <span class="acct"><span class="dot" style:background={hueColor(acct.hue, app.mode)}></span>{acct.email}</span>
            {/if}
            {#if thread.length > 1}<span class="count">{thread.length} messages</span>{/if}
          </div>

          {#if m.meetingType && m.meetingType !== "none"}
            <InviteCard message={m} />
          {/if}
          {#if m.unsubscribe && unsubDone !== m.id}
            <div class="unsub">
              <MailX size={14} />
              <span>Mailing list from <b>{displayName(m.from)}</b></span>
              <span class="spacer"></span>
              <button class="btn sm" onclick={() => unsubscribe(m)} disabled={unsubBusy}>
                {#if unsubBusy}<LoaderCircle size={12} class="spin" />{/if}
                {m.unsubscribe.oneClick ? "Unsubscribe" : m.unsubscribe.url ? "Unsubscribe…" : "Unsubscribe by email"}
              </button>
            </div>
          {:else if unsubDone === m.id}
            <div class="unsub done"><MailX size={14} /> Unsubscribed. You shouldn't get more mail from this list.</div>
          {/if}
          {@render email(m, true)}
          <TldrCard {thread} message={m} />
          <QuickReply message={m} {thread} />

          {#if associated.length}
            <section class="associated" aria-label="Related emails in this thread">
              <h3>In this conversation <span>{associated.length} related {associated.length === 1 ? "email" : "emails"}</span></h3>
              {#each associated as t (t.id)}
                {#if expanded.has(t.id)}
                  {@render email(t)}
                {:else}
                  <button class="collapsed" class:unread={!t.isRead} onclick={() => toggle(t.id)} aria-expanded="false">
                    <Avatar addr={t.from} size={26} />
                    {#if !t.isRead}<span class="unread-dot" title="Unread" aria-label="Unread email"></span>{/if}
                    <span class="cname">{displayName(t.from)}</span>
                    <span class="cprev">{t.preview}</span>
                    <MessageStatus message={t} compact />
                    <time class="mono">{shortTime(t.receivedAt)}</time>
                  </button>
                {/if}
              {/each}
            </section>
          {/if}
        </article>
      {/key}
    </div>

    {#if hover}
      <div class="linkbar" class:warn={hoverMismatch} role="status">
        {#if hoverMismatch}<TriangleAlert size={12} /><span class="lb-note">Says {hostOf(hover.text)}, goes to</span>{:else}<Link2 size={12} />{/if}
        <span class="lb-url">{hoverShown}</span>
      </div>
    {/if}
  {:else if app.openLoading}
    <div class="placeholder"><LoaderCircle size={20} class="spin" /></div>
  {:else}
    <div class="placeholder">
      <div class="mark"><Logo size={44} /></div>
      <div class="ph-title">
        {app.messages.length ? "Select a message" : "Nothing selected"}
      </div>
      <div class="ph-keys">
        <span><kbd>j</kbd><kbd>k</kbd> move</span>
        <span><kbd>e</kbd> archive</span>
        <span><kbd>v</kbd> move to</span>
        <span><kbd>c</kbd> compose</span>
        <span><kbd>^J</kbd> ask Tern</span>
      </div>
    </div>
  {/if}
</section>

<style>
  .reader {
    position: relative;
    container-type: inline-size;
    container-name: reader;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: color-mix(in oklab, var(--surface) 92%, var(--bg-lighter));
  }
  .toolbar {
    min-height: 48px;
    flex-wrap: wrap;
    gap: 4px;
    flex: none;
    display: flex;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
  }
  .reply-group { margin-left: auto; }
  .overflow { position: relative; }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 30;
    min-width: 210px;
    padding: 4px;
    border-radius: var(--r);
    background: var(--raised);
    box-shadow: var(--shadow);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border-radius: 6px;
    font-size: 12.5px;
    color: var(--fg);
    text-align: left;
  }
  .menu button:hover { background: var(--hover); }
  .back-list { display: none; }
  .group {
    display: flex;
    flex-wrap: wrap;
    max-width: 100%;
    gap: 2px;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
  }
  article {
    max-width: 860px;
    margin: 0 auto;
    padding: 26px 36px 60px;
    animation: fade-up 200ms var(--ease);
  }
  .subject {
    margin: 0 0 8px;
    font-size: 21px;
    line-height: 1.3;
    font-weight: 680;
    letter-spacing: -0.02em;
    color: var(--fg-bright);
    user-select: text;
  }
  .meta-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
    font-size: 12px;
    color: var(--muted);
  }
  .acct {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .associated { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); }
  .associated h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin: 0 0 12px; font-size: 12px; font-weight: 600; color: var(--fg-dim); }
  .associated h3 span { color: var(--muted); font-size: 11px; font-weight: 400; }
  .when {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .unread-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .collapsed:not(.unread) .cname { color: var(--muted); font-weight: 500; }
  .collapsed.unread .cname { color: var(--fg-bright); font-weight: 650; }
  .msg {
    margin-bottom: 14px;
  }
  .msg + .msg,
  .collapsed + .msg {
    margin-top: 6px;
  }
  .msg-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 0 14px;
  }
  .avatar-btn {
    display: grid;
    border-radius: 50%;
    transition: transform 120ms var(--ease);
  }
  .avatar-btn:hover {
    transform: scale(1.06);
  }
  .who {
    flex: 1;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .name {
    font-weight: 620;
    color: var(--fg-bright);
  }
  .person {
    font: inherit;
    color: inherit;
    border-radius: 4px;
    text-decoration: none;
  }
  .person:hover {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: var(--accent-line);
    text-underline-offset: 2px;
  }
  .email {
    font-size: 12px;
    color: var(--muted);
    user-select: text;
  }
  .quiet {
    font-size: 12px;
    color: var(--muted);
    border-radius: 4px;
    padding: 1px 4px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .quiet:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .line.sub {
    font-size: 12px;
    color: var(--muted);
    margin-top: 1px;
  }
  .when time {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .collapsed {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    margin-bottom: 6px;
    border-radius: 10px;
    text-align: left;
    background: var(--hover);
    transition: background var(--t);
  }
  .collapsed:hover {
    background: color-mix(in oklab, var(--fg) 8%, transparent);
  }
  .cname {
    font-weight: 600;
    font-size: 12.5px;
    white-space: nowrap;
  }
  .cprev {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .collapsed time {
    font-size: 11px;
    color: var(--muted);
  }
  .atts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }
  .linkbar {
    position: absolute;
    left: 10px;
    bottom: 10px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: calc(100% - 20px);
    padding: 5px 10px;
    border-radius: 8px;
    font-size: 11.5px;
    color: var(--fg-dim);
    background: var(--raised);
    box-shadow: var(--shadow-sm);
    pointer-events: none;
    animation: fade-up 120ms var(--ease);
  }
  .linkbar :global(svg) {
    color: var(--muted);
    flex: none;
  }
  .linkbar.warn {
    color: var(--fg);
    box-shadow: var(--shadow-sm), inset 0 0 0 1px color-mix(in oklab, var(--red) 40%, transparent);
  }
  .linkbar.warn :global(svg) {
    color: var(--red);
  }
  .lb-note {
    color: var(--red);
    flex: none;
  }
  .lb-url {
    font-family: var(--font-mono);
    font-size: 11px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    color: var(--muted);
  }
  .mark {
    opacity: 0.5;
    filter: saturate(0.8);
  }
  .ph-title {
    font-size: 13px;
  }
  .ph-keys {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    padding: 0 16px;
    gap: 16px;
    font-size: 11.5px;
  }
  .ph-keys kbd {
    margin-right: 3px;
  }
  .unsub {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
    padding: 8px 10px 8px 12px;
    border-radius: 10px;
    font-size: 12.5px;
    color: var(--fg-dim);
    background: color-mix(in oklab, var(--magenta) 8%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--magenta) 22%, var(--line));
  }
  .unsub b {
    color: var(--fg);
    font-weight: 600;
  }
  .unsub.done {
    color: var(--green);
    background: color-mix(in oklab, var(--green) 8%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--green) 25%, var(--line));
  }
  .unsub .spacer {
    flex: 1;
  }
  @container reader (max-width: 450px) {
    article { padding: 18px 14px 40px; }
    .meta-row { flex-wrap: wrap; gap: 6px; }
    .subject { font-size: 18px; }
  }
</style>
