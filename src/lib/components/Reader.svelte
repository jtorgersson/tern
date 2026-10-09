<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { connect } from "$lib/state/connect.svelte";
  import { MessageCircle } from "@lucide/svelte";
  import { composer } from "$lib/state/composer.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { api } from "$lib/api";
  import { hueColor } from "$lib/theme";
  import { longTime, shortTime } from "$lib/util/time";
  import { displayName, formatBytes, errMsg } from "$lib/util/misc";
  import type { Addr, Attachment, MessageFull } from "$lib/types";
  import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
  import Avatar from "./Avatar.svelte";
  import MailFrame from "./MailFrame.svelte";
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
    Paperclip,
    Download,
    LoaderCircle,
    AlarmClock,
    MailX,
    SquareArrowOutUpRight,
    X,
    ChevronUp,
    ArrowLeft,
  } from "@lucide/svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { parseMailto } from "$lib/util/mailto";

  // ---- unsubscribe ----
  let unsubBusy = $state(false);
  let unsubDone = $state<string | null>(null);
  $effect(() => {
    void app.open?.id;
    unsubDone = null;
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

  function addrList(list: Addr[]): string {
    return list.map((a) => displayName(a)).join(", ");
  }

  let saving = $state<string | null>(null);
  async function save(msg: MessageFull, a: Attachment) {
    saving = a.id;
    try {
      const path = await api.saveAttachment(msg.id, a.id);
      toasts.show(`Saved ${a.name}`, {
        kind: "success",
        timeout: 8000,
        action: { label: "Open", run: () => openPath(path).catch(() => revealItemInDir(path)) },
      });
    } catch (e) {
      toasts.error(`Could not save ${a.name}: ${errMsg(e)}`);
    } finally {
      saving = null;
    }
  }
</script>

{#snippet email(t: MessageFull, primary = false)}
  <div class="msg">
    <header class="msg-head">
      <Avatar addr={t.from} size={38} />
      <div class="who">
        <div class="line">
          <span class="name">{displayName(t.from)}</span>
          <span class="email">{t.from.email}</span>
        </div>
        <div class="line sub">
          <span>to {addrList(t.to) || "—"}</span>
          {#if t.cc.length}<span>· cc {addrList(t.cc)}</span>{/if}
        </div>
      </div>
      <time class="mono">{longTime(t.receivedAt)}</time>
      {#if !primary}<button class="icon-btn" aria-label="Collapse related email" onclick={() => toggle(t.id)}><ChevronUp size={14} /></button>{/if}
    </header>

    <div class="message-status"><MessageStatus message={t} /></div>
    <div class="content">
      <MailFrame html={t.bodyHtml} />
    </div>
    {#if !t.meetingType || t.meetingType === "none"}
      <DateChips message={t} />
    {/if}

    {#if t.attachments.some((a) => !a.isInline)}
      <div class="atts">
        {#each t.attachments.filter((a) => !a.isInline) as a (a.id)}
          <button class="att" onclick={() => save(t, a)} title="Save to Downloads">
            <span class="att-ic"><Paperclip size={14} /></span>
            <span class="att-name">{a.name}</span>
            <span class="att-size mono">{formatBytes(a.size)}</span>
            {#if saving === a.id}<LoaderCircle size={13} class="spin" />{:else}<Download size={13} class="dl" />{/if}
          </button>
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
        <button class="icon-btn" class:on={m.isFlagged} title="Flag (s)" onclick={() => app.toggleFlag([m.id])}>
          <Star size={16} fill={m.isFlagged ? "currentColor" : "none"} />
        </button>
        <button class="icon-btn" title="Mark unread (u)" onclick={() => app.setRead([m.id], false)}><MailOpen size={16} /></button>
        {#if m.snoozedUntil}
          <button class="icon-btn on" title="Snoozed — click to bring it back now" onclick={() => app.unsnooze([m.id])}><AlarmClock size={16} /></button>
        {:else}
          <button class="icon-btn" title="Snooze (z)" onclick={() => app.openSnooze([m.id])}><AlarmClock size={16} /></button>
        {/if}
      </div>
      <div class="group">
        <button class="icon-btn" title="Reply (r)" onclick={() => composer.reply(m, "reply")}><Reply size={16} /></button>
        <button class="icon-btn" title="Reply all (R)" onclick={() => composer.reply(m, "replyAll")}><ReplyAll size={16} /></button>
        <button class="icon-btn" title="Forward (f)" onclick={() => composer.reply(m, "forward")}><Forward size={16} /></button>
        {#if m.webLink}
          <button class="icon-btn" title="Open in Outlook on the web" onclick={() => openUrl(m.webLink!)}><ExternalLink size={16} /></button>
        {/if}
        {#if app.windowKind === "main"}
          <button class="icon-btn" title="Discuss this email in Connect" aria-label="Discuss in Connect" onclick={() => discussEmail(m)}><MessageCircle size={16} /></button>
          <button class="icon-btn" title="Open in new window (O)" onclick={() => app.openInWindow(m.id)}><SquareArrowOutUpRight size={16} /></button>
        {:else}
          <button class="icon-btn" title="Close window (Esc)" onclick={() => getCurrentWindow().close()}><X size={16} /></button>
        {/if}
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
        <span><kbd>c</kbd> compose</span>
        <span><kbd>^J</kbd> ask Tern</span>
      </div>
    </div>
  {/if}
</section>

<style>
  .reader {
    container-type: inline-size;
    container-name: reader;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: color-mix(in oklab, var(--surface) 92%, var(--bg-lighter));
  }
  .toolbar {
    min-height: 52px;
    flex-wrap: wrap;
    gap: 4px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
  }
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
  .message-status:empty { display: none; }
  .message-status { margin-bottom: 10px; }
  .unread-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .collapsed.unread .cname { color: var(--fg-bright); }
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
  .email {
    font-size: 12px;
    color: var(--muted);
    user-select: text;
  }
  .line.sub {
    font-size: 12px;
    color: var(--muted);
    margin-top: 1px;
  }
  .msg-head time {
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
  .att {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 36px;
    padding: 0 12px 0 6px;
    border-radius: 10px;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
    max-width: 320px;
    transition: all var(--t);
  }
  .att:hover {
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .att-ic {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .att-name {
    font-size: 12.5px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .att-size {
    font-size: 10.5px;
    color: var(--muted);
  }
  .att :global(.dl) {
    color: var(--muted);
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
