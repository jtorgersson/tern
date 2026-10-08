<script lang="ts">
  import { tick } from "svelte";
  import DOMPurify from "dompurify";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { MessageCircle, Hash, ArrowLeft, ExternalLink, RefreshCw, Send, X, Maximize2, Minimize2 } from "@lucide/svelte";
  import { app } from "$lib/state/app.svelte";
  import { connect } from "$lib/state/connect.svelte";
  import { api } from "$lib/api";
  import { connectApi, chatTitle, mergeMessages, previewText, type ConnectResource, type ConnectChat, type ConnectGroup, type ConnectMessage, type Conversation } from "$lib/connect";
  import { errMsg } from "$lib/util/misc";

  let accountId = $state("");
  const account = $derived(app.ownAccounts.find(a => a.id === accountId));
  const personal = $derived(account?.tenantId === "9188040d-6c67-4c5b-b112-36a304b66dad");
  let consenting = $state(false);
  let consentError = $state("");
  let listing = $state<ConnectResource>({ kind: "chats" });
  let groupTitle = $state("");
  let rows = $state<(ConnectChat | ConnectGroup)[]>([]);
  let listNext = $state<string | null>(null);
  let listLoading = $state(false);
  let listError = $state("");
  let filter = $state("");
  let active = $state<Conversation | null>(null);
  let parent = $state<Conversation | null>(null);
  let rootMessage = $state<ConnectMessage | null>(null);
  let messages = $state<ConnectMessage[]>([]);
  let messageNext = $state<string | null>(null);
  let messageLoading = $state(false);
  let olderLoading = $state(false);
  let messageError = $state("");
  let sendError = $state("");
  let sending = $state(false);
  let drafts = $state<Record<string, string>>({});
  let scroller: HTMLDivElement | undefined = $state();
  let listSeq = 0;
  let messageSeq = 0;
  let accountEpoch = 0;
  const draftKey = $derived(`${accountId}:${JSON.stringify(active?.resource)}`);
  const draft = $derived(drafts[draftKey] ?? "");
  const visibleRows = $derived(rows.filter(r => rowTitle(r).toLowerCase().includes(filter.toLowerCase())));

  $effect(() => {
    if (!app.ownAccounts.some(a => a.id === accountId)) accountId = app.ownAccounts[0]?.id ?? "";
  });
  $effect(() => {
    const id = accountId;
    const enabled = account?.connectConsent;
    accountEpoch++;
    listSeq++;
    messageSeq++;
    listing = { kind: "chats" };
    rows = [];
    listNext = null;
    active = parent = null;
    rootMessage = null;
    messages = [];
    messageNext = null;
    messageLoading = olderLoading = false;
    consentError = listError = messageError = sendError = "";
    filter = "";
    if (id && enabled) void loadList({ kind: "chats" });
  });
  $effect(() => {
    // Poll only while mounted/open, and pause when the app is in the background.
    const timer = setInterval(() => {
      if (!connect.open || document.visibilityState !== "visible" || !account?.connectConsent) return;
      if (active && !messageLoading && !olderLoading && !sending) void loadMessages(true);
    }, 15_000);
    const listTimer = setInterval(() => {
      if (connect.open && document.visibilityState === "visible" && account?.connectConsent && !listLoading)
        void loadList(listing, false, true);
    }, 60_000);
    return () => { clearInterval(timer); clearInterval(listTimer); };
  });

  function rowTitle(row: ConnectChat | ConnectGroup) {
    return "chatType" in row ? chatTitle(row, accountId) : row.displayName;
  }
  async function enable() {
    const id = accountId;
    consenting = true;
    consentError = "";
    try {
      const updated = await connectApi.enable(id);
      app.accounts = app.accounts.map(a => a.id === updated.id ? updated : a);
    } catch (e) { if (id === accountId) consentError = errMsg(e); }
    finally { consenting = false; }
  }
  async function loadList(resource: ConnectResource, more = false, silent = false) {
    const seq = ++listSeq;
    const id = accountId;
    const next = more ? listNext : null;
    if (more && !next) return;
    listing = resource;
    if (!more && !silent) { rows = []; listNext = null; filter = ""; }
    listLoading = true;
    if (!silent) listError = "";
    try {
      const page = await connectApi.list<ConnectChat | ConnectGroup>(id, resource, next);
      if (seq !== listSeq || id !== accountId) return;
      rows = more || silent ? [...new Map([...rows, ...page.value].map(r => [r.id, r])).values()] : page.value;
      // A background first-page refresh must not reset an older pagination cursor.
      if (!silent) listNext = page["@odata.nextLink"] ?? null;
      listError = "";
    } catch (e) { if (seq === listSeq) listError = errMsg(e); }
    finally { if (seq === listSeq) listLoading = false; }
  }
  function choose(row: ConnectChat | ConnectGroup) {
    if (listing.kind === "teams") {
      groupTitle = rowTitle(row);
      void loadList({ kind: "channels", teamId: row.id });
    } else {
      parent = null;
      rootMessage = null;
      select({ title: rowTitle(row), webUrl: row.webUrl, resource: listing.kind === "channels"
        ? { kind: "channel", teamId: listing.teamId, channelId: row.id }
        : { kind: "chat", chatId: row.id } });
    }
  }
  function select(conversation: Conversation) {
    active = conversation;
    messages = [];
    messageNext = null;
    messageError = sendError = "";
    olderLoading = false;
    void loadMessages();
  }
  async function loadMessages(silent = false) {
    if (!active) return;
    const seq = ++messageSeq;
    const id = accountId;
    const resource = active.resource;
    const nearBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    messageLoading = true;
    try {
      const page = await connectApi.list<ConnectMessage>(id, resource);
      if (seq !== messageSeq || id !== accountId) return;
      messages = mergeMessages(silent ? messages : [], page.value);
      if (!silent) messageNext = page["@odata.nextLink"] ?? null;
      messageError = "";
      if (!silent || nearBottom) { await tick(); if (seq === messageSeq && scroller) scroller.scrollTop = scroller.scrollHeight; }
    } catch (e) { if (seq === messageSeq) messageError = errMsg(e); }
    finally { if (seq === messageSeq) messageLoading = false; }
  }
  async function older() {
    if (!active || !messageNext || olderLoading || messageLoading) return;
    const seq = messageSeq;
    const id = accountId;
    const before = scroller?.scrollHeight ?? 0;
    const top = scroller?.scrollTop ?? 0;
    olderLoading = true;
    try {
      const page = await connectApi.list<ConnectMessage>(id, active.resource, messageNext);
      if (seq !== messageSeq || id !== accountId) return;
      messages = mergeMessages(messages, page.value);
      messageNext = page["@odata.nextLink"] ?? null;
      await tick();
      if (seq === messageSeq && scroller) scroller.scrollTop = top + scroller.scrollHeight - before;
    } catch (e) { if (seq === messageSeq) messageError = errMsg(e); }
    finally { if (seq === messageSeq) olderLoading = false; }
  }
  function replies(message: ConnectMessage) {
    if (active?.resource.kind !== "channel") return;
    const { teamId, channelId } = active.resource;
    parent = active;
    rootMessage = message;
    select({ title: "Thread", webUrl: message.webUrl || active.webUrl, resource: { kind: "replies", teamId, channelId, messageId: message.id } });
  }
  async function send() {
    if (!active || !draft.trim() || sending) return;
    const key = draftKey;
    const text = draft;
    const epoch = accountEpoch;
    sending = true;
    sendError = "";
    try {
      const sent = await connectApi.send(accountId, active.resource, text);
      if (drafts[key] === text) drafts[key] = "";
      if (epoch === accountEpoch && key === draftKey) {
        messages = mergeMessages(messages, [sent]);
        await tick();
        if (key === draftKey && scroller) scroller.scrollTop = scroller.scrollHeight;
      }
    } catch (e) {
      if (epoch === accountEpoch && key === draftKey) sendError = `${errMsg(e)} Check the conversation before trying again; delivery may be uncertain.`;
    } finally { sending = false; }
  }
  async function external(url = active?.webUrl || "https://teams.microsoft.com") {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error("Only HTTPS links can be opened");
      await openUrl(parsed.href);
    } catch (e) { messageError = errMsg(e); }
  }
  function safeBody(html: string) {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ["p", "br", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "blockquote", "pre", "code", "a", "span"],
      ALLOWED_ATTR: ["href", "title"],
      ALLOW_DATA_ATTR: false,
    });
  }
  function bodyLink(e: MouseEvent) {
    const link = (e.target as Element).closest("a");
    if (link) { e.preventDefault(); e.stopPropagation(); void external(link.getAttribute("href") || ""); }
  }
  function when(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(app.settings?.ui.locale ?? "en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }
</script>

<section class="connect" data-connect aria-label="Connect workspace">
  <header class="heading">
    <MessageCircle size={19} />
    <div class="brand"><strong>Connect</strong><span>Linked to Microsoft Teams</span></div>
    <button class="icon-btn" title="Open Microsoft Teams" aria-label="Open Microsoft Teams" onclick={() => external("https://teams.microsoft.com")}><ExternalLink size={15} /></button>
    <button class="icon-btn" title={connect.expanded ? "Dock beside mail and calendar" : "Expand Connect"} aria-label={connect.expanded ? "Dock Connect" : "Expand Connect"} onclick={() => connect.expanded = !connect.expanded}>
      {#if connect.expanded}<Minimize2 size={15} />{:else}<Maximize2 size={15} />{/if}
    </button>
    <button class="icon-btn" aria-label="Close Connect" onclick={() => connect.toggle()}><X size={17} /></button>
  </header>
  <div class="account-row">
    <select aria-label="Connect account" bind:value={accountId} disabled={consenting}>
      {#each app.ownAccounts as a (a.id)}<option value={a.id}>{a.email}</option>{/each}
    </select>
    {#if account?.connectConsent}<button class="text-btn" disabled={consenting} onclick={enable}>{consenting ? "Connecting…" : "Reconnect"}</button>{/if}
  </div>
  {#if consentError}<p class="error" role="alert">{consentError}</p>{/if}
  {#if !account || !account.connectConsent || personal}
    <div class="welcome">
      <div class="welcome-icon"><MessageCircle size={30} /></div>
      <h2>Your conversations, alongside your day.</h2>
      <p>Read and reply to Microsoft Teams chats and channels while keeping your mail or calendar open.</p>
      {#if personal}<p>Connect needs a Microsoft work or school account with Teams. Choose or add one to get started.</p>
      {:else if account}<button class="btn primary" disabled={consenting} onclick={enable}>{consenting ? "Waiting for Microsoft…" : "Enable Connect"}</button>
        <p class="fine">Microsoft will ask you to allow chat and channel access. Your organization may require an administrator’s approval.</p>
      {/if}
      {#if consenting}<button class="text-btn" onclick={() => api.cancelAuth()}>Cancel sign-in</button>{/if}
      <button class="text-btn" onclick={() => app.openSettings("accounts")}>Manage accounts</button>
    </div>
  {:else}
    <div class="workspace" class:has-conversation={!!active}>
      <div class="browser">
        <div class="tabs">
          <button class:chosen={listing.kind === "chats"} onclick={() => loadList({ kind: "chats" })}><MessageCircle size={14} />Chats</button>
          <button class:chosen={listing.kind !== "chats"} onclick={() => loadList({ kind: "teams" })}><Hash size={14} />Channels</button>
          <button class="icon-btn refresh" disabled={listLoading} aria-label="Refresh conversations" onclick={() => loadList(listing)}><RefreshCw size={13} class={listLoading ? "spin" : ""} /></button>
        </div>
        {#if listing.kind === "channels"}<button class="group-back" onclick={() => loadList({ kind: "teams" })}><ArrowLeft size={13} />{groupTitle}</button>{/if}
        <input class="filter" aria-label="Filter loaded conversations" placeholder="Find a conversation…" bind:value={filter} />
        {#if listError}<p class="error" role="alert">{listError}</p>{/if}
        <div class="conversations">
          {#each visibleRows as row (row.id)}
            {@const selected = active?.resource.kind === "chat" ? active.resource.chatId === row.id : active?.resource.kind === "channel" ? active.resource.channelId === row.id : false}
            <button class="conversation" class:selected onclick={() => choose(row)}>
              <span class="conversation-icon">{#if "chatType" in row}<MessageCircle size={16} />{:else}<Hash size={16} />{/if}</span>
              <span class="conversation-copy"><strong>{rowTitle(row)}</strong>
                {#if "chatType" in row}<small>{previewText(row.lastMessagePreview?.body?.content || "") || (row.chatType === "meeting" ? "Meeting chat" : "Open conversation")}</small>{/if}
              </span>
            </button>
          {:else}<p class="empty">{listLoading ? "Loading conversations…" : filter ? "No matching conversations." : listError ? "Conversations couldn’t be loaded." : listing.kind === "teams" ? "No joined teams found." : "No conversations found."}</p>{/each}
          {#if listNext}<button class="load-more" disabled={listLoading} onclick={() => loadList(listing, true)}>Load more conversations</button>{/if}
        </div>
      </div>
      <div class="conversation-pane">
        {#if active}
          <div class="conversation-heading">
            {#if parent}<button class="icon-btn" aria-label="Back to channel" onclick={() => { const p = parent!; parent = null; rootMessage = null; select(p); }}><ArrowLeft size={16} /></button>{/if}
            <div><strong>{active.title}</strong><small>{parent?.title || (active.resource.kind === "channel" ? "Channel posts" : "Microsoft Teams conversation")}</small></div>
            <button class="icon-btn" disabled={messageLoading || olderLoading} aria-label="Refresh messages" onclick={() => loadMessages(true)}><RefreshCw size={14} class={messageLoading ? "spin" : ""} /></button>
            <button class="icon-btn" title="Open in Teams for calls, files, and more" aria-label="Open conversation in Teams" onclick={() => external()}><ExternalLink size={14} /></button>
          </div>
          {#if messageError}<p class="error" role="alert">{messageError}</p>{/if}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="messages" bind:this={scroller} onclick={bodyLink}>
            {#if rootMessage}<div class="thread-root"><strong>{rootMessage.from?.user?.displayName || "Channel post"}</strong><p>{previewText(rootMessage.body.content)}</p></div>{/if}
            {#if messageNext}<button class="load-more" disabled={olderLoading || messageLoading} onclick={older}>{olderLoading ? "Loading…" : "Load more messages"}</button>{/if}
            {#each messages as message (message.id)}
              <article class="message" class:mine={`ms-${message.from?.user?.id}` === accountId}>
                <div class="message-meta"><strong>{message.from?.user?.displayName || message.from?.application?.displayName || "Teams"}</strong><time datetime={message.createdDateTime}>{when(message.createdDateTime)}</time></div>
                {#if message.deletedDateTime}<p class="deleted">Message deleted</p>
                {:else}
                  {#if message.subject}<strong>{message.subject}</strong>{/if}
                  {#if message.body.contentType === "html"}<div class="message-body">{@html safeBody(message.body.content)}</div>
                  {:else}<div class="message-body plain">{message.body.content || "Activity in Teams"}</div>{/if}
                  {#if message.lastEditedDateTime}<small class="edited">Edited</small>{/if}
                  {#if message.attachments?.length}<button class="text-btn" onclick={() => external(message.webUrl || active?.webUrl)}>Open {message.attachments.length} attachment(s) in Teams <ExternalLink size={11} /></button>{/if}
                  {#if active.resource.kind === "channel"}<button class="text-btn" onclick={() => replies(message)}>View thread / reply</button>{/if}
                {/if}
              </article>
            {:else}<p class="empty">{messageLoading ? "Loading messages…" : messageError ? "Messages couldn’t be loaded." : "No messages yet. Start the conversation below."}</p>{/each}
          </div>
          <form class="compose" onsubmit={(e) => { e.preventDefault(); void send(); }}>
            {#if sendError}<p class="error" role="alert">{sendError}</p>{/if}
            <textarea aria-label="Message" placeholder={active.resource.kind === "channel" ? "Start a new channel post…" : "Write a message…"} value={draft} oninput={(e) => drafts[draftKey] = e.currentTarget.value} rows="3" maxlength="20000"
              onkeydown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void send(); } }}></textarea>
            <div class="compose-footer"><span>Ctrl + Enter to send · Updates every 15s</span><button class="btn primary" disabled={!draft.trim() || sending} type="submit"><Send size={13} />{sending ? "Sending…" : "Send"}</button></div>
          </form>
        {:else}<div class="empty-state"><MessageCircle size={32} /><h3>Keep the conversation close</h3><p>Choose a chat or channel. Your mail and calendar stay right beside it.</p><button class="text-btn" onclick={() => external("https://teams.microsoft.com/l/chat/0/0")}>Start a new chat in Teams <ExternalLink size={12} /></button></div>{/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .connect { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--line); container-type: inline-size; }
  .heading { display: flex; align-items: center; gap: 10px; padding: 16px; border-bottom: 1px solid var(--line); color: var(--accent); }
  .brand { flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .brand strong { color: var(--fg-bright); font-size: 16px; }
  .brand span, small { font-size: 11px; color: var(--muted); }
  .account-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  select { flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--fg); padding: 6px; font-size: 12px; }
  .welcome { margin: auto; max-width: 400px; padding: 28px; text-align: center; }
  .welcome-icon { display: inline-flex; padding: 18px; border-radius: 20px; color: var(--accent); background: var(--accent-soft); }
  h2 { font-size: 23px; font-weight: 600; letter-spacing: -.04em; line-height: 1.3; margin: 24px 0 12px; }
  .welcome p, .empty-state p { color: var(--muted); font-size: 13px; line-height: 1.7; }
  .welcome .fine { font-size: 11px; margin-top: 16px; }
  .workspace { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .browser { display: flex; flex-direction: column; min-height: 120px; max-height: 40%; border-bottom: 1px solid var(--line); }
  .workspace:not(.has-conversation) .browser { max-height: 60%; }
  .tabs { display: flex; align-items: center; padding: 8px 12px; gap: 6px; }
  .tabs > button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px; border-radius: 6px; color: var(--muted); font-size: 12px; }
  .tabs > button.chosen { color: var(--accent); background: var(--accent-soft); }
  .tabs .refresh { margin-left: auto; }
  .filter { flex: none; margin: 0 14px 8px; padding: 7px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; min-width: 0; color: var(--fg); font-size: 12px; }
  .conversations { overflow-y: auto; min-height: 0; padding: 0 8px 8px; }
  .conversation { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px; text-align: left; border-radius: 7px; }
  .conversation:hover { background: var(--panel); }
  .conversation.selected { background: var(--accent-soft); }
  .conversation-icon { color: var(--muted); display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--panel); flex: none; }
  .conversation-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
  .conversation-copy strong { font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conversation-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-back { display: flex; align-items: center; gap: 6px; padding: 0 16px 9px; font-size: 12px; color: var(--muted); }
  .conversation-pane { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .conversation-heading { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .conversation-heading > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .conversation-heading strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; overflow-wrap: anywhere; user-select: text; }
  .message { margin: 0 0 18px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .message.mine { border-color: var(--accent-line); background: var(--accent-soft); }
  .message-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; margin-bottom: 7px; }
  .message-meta strong { font-size: 11px; font-weight: 600; }
  time { color: var(--muted); font-size: 10px; margin-left: auto; }
  .message-body { font-size: 13px; line-height: 1.6; }
  .message-body.plain { white-space: pre-wrap; }
  .message-body :global(p) { margin: 0 0 6px; }
  .message-body :global(a) { color: var(--accent); text-decoration: underline; }
  .message-body :global(pre) { white-space: pre-wrap; }
  .message-body :global(blockquote) { border-left: 2px solid var(--accent-line); padding-left: 10px; margin-left: 0; }
  .deleted, .edited { color: var(--muted); font-size: 11px; }
  .thread-root { padding: 12px; border-left: 2px solid var(--accent); background: var(--panel); margin-bottom: 16px; font-size: 12px; }
  .compose { border-top: 1px solid var(--line); padding: 12px; }
  textarea { width: 100%; resize: vertical; max-height: 200px; min-height: 64px; box-sizing: border-box; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; color: var(--fg); font-family: inherit; font-size: 13px; }
  textarea:focus { outline: 1px solid var(--accent); }
  .compose-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 8px; }
  .compose-footer span { font-size: 10px; color: var(--muted); }
  .text-btn { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); font-size: 11px; padding: 6px 0; }
  .message .text-btn { display: flex; margin-top: 4px; }
  .load-more { display: block; color: var(--accent); font-size: 11px; padding: 10px; margin: auto; }
  .empty { padding: 12px; color: var(--muted); font-size: 12px; text-align: center; }
  .empty-state { margin: auto; text-align: center; max-width: 280px; padding: 25px; color: var(--muted); }
  .empty-state h3 { font-size: 15px; color: var(--fg); }
  .error { padding: 10px 14px; margin: 0; font-size: 12px; color: var(--red); line-height: 1.5; overflow-wrap: anywhere; }
  button:disabled { opacity: .5; cursor: default; }
  @container (min-width: 700px) {
    .workspace { flex-direction: row; }
    .browser, .workspace:not(.has-conversation) .browser { width: 260px; flex: none; max-height: none; border-right: 1px solid var(--line); border-bottom: 0; }
  }
</style>
