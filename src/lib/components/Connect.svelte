<script lang="ts">
  import { tick, untrack } from "svelte";
  import DOMPurify from "dompurify";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { MessageCircle, Hash, ArrowLeft, ExternalLink, RefreshCw, Send, X, Maximize2, Minimize2, Plus, Mail, CalendarPlus, Search, Pin, PinOff } from "@lucide/svelte";
  import { app } from "$lib/state/app.svelte";
  import { connect } from "$lib/state/connect.svelte";
  import { api } from "$lib/api";
  import { connectApi, chatTitle, chatUnread, readCursor, unreadMessages, mergeMessages, previewText, type GraphPage, type ConnectResource, type ConnectChat, type ConnectGroup, type ConnectMessage, type Conversation } from "$lib/connect";
  import { errMsg, textToHtml } from "$lib/util/misc";
  import { conversationText } from "$lib/connect";
  import { composer } from "$lib/state/composer.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { search } from "$lib/state/search.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import NewConversation from "./NewConversation.svelte";
  import ConnectAssistant from "./ConnectAssistant.svelte";
  import EmojiPicker from "./EmojiPicker.svelte";
  import { insertEmoji } from "$lib/util/emoji";

  let accountId = $state("");
  const account = $derived(app.ownAccounts.find(a => a.id === accountId));
  const personal = $derived(account?.tenantId === "9188040d-6c67-4c5b-b112-36a304b66dad");
  let newMode = $state(false);
  let newRecipient = $state("");
  let newDraft = $state("");
  let wizardVersion = $state(0);
  let highlighted = $state<string | null>(null);
  let previousAccount = "";
  let consenting = $state(false);
  let consentError = $state("");
  let listing = $state<ConnectResource>({ kind: "chats" });
  let groupTitle = $state("");
  let rows = $state<(ConnectChat | ConnectGroup)[]>([]);
  let listNext = $state<string | null>(null);
  let listLoading = $state(false);
  let listError = $state("");
  let filter = $state("");
  let unreadOnly = $state(false);
  let entryCursor = $state<number | null>(null);
  let active = $state<Conversation | null>(null);
  let browsing = $state(false);
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
  let messageEditor: HTMLTextAreaElement | undefined = $state();
  let listSeq = 0;
  let messageSeq = 0;
  let accountEpoch = 0;
  const draftKey = $derived(`${accountId}:${JSON.stringify(active?.resource)}`);
  const draft = $derived(drafts[draftKey] ?? "");
  const pins = $derived(connect.pins.filter(p => p.accountId === accountId && p.conversation.title.toLowerCase().includes(filter.toLowerCase())));
  const unreadCount = $derived(rows.filter(rowUnread).length);
  const visibleRows = $derived(rows.filter(r => rowTitle(r).toLowerCase().includes(filter.toLowerCase()) && (!unreadOnly || listing.kind !== "chats" || rowUnread(r))));
  const firstUnread = $derived(entryCursor === null ? undefined : unreadMessages(messages, accountId, entryCursor)[0]);
  const pending = $derived(active ? unreadMessages(messages, accountId, Math.max(currentCursor(active.resource), entryCursor ?? 0)) : []);

  function receipt(resource: ConnectResource) {
    const row = resource.kind === "chat" ? rows.find(r => r.id === resource.chatId && "chatType" in r) as ConnectChat | undefined : undefined;
    return row?.viewpoint?.lastMessageReadDateTime;
  }
  function currentCursor(resource: ConnectResource) {
    return readCursor(connect.read[connect.readKey(accountId, resource)], receipt(resource));
  }
  function rowUnread(row: ConnectChat | ConnectGroup) {
    return "chatType" in row && chatUnread(row, accountId, connect.read[connect.readKey(accountId, { kind: "chat", chatId: row.id })]);
  }
  function atBottom() {
    return !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
  }
  function readVisible() {
    if (!active || messageLoading || !connect.open || document.visibilityState !== "visible" || !atBottom()) return;
    const last = messages[messages.length - 1];
    if (last) connect.markRead(accountId, active.resource, last.createdDateTime);
  }
  function jumpToLatest() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    readVisible();
  }
  async function addEmoji(emoji: string) {
    const key = draftKey;
    const inserted = insertEmoji(draft, emoji, messageEditor?.selectionStart, messageEditor?.selectionEnd, 20000);
    drafts[key] = inserted.value;
    await tick();
    if (key !== draftKey) return;
    messageEditor?.focus();
    messageEditor?.setSelectionRange(inserted.caret, inserted.caret);
  }

  $effect(() => {
    if (!app.ownAccounts.some(a => a.id === accountId)) accountId = app.ownAccounts[0]?.id ?? "";
  });
  $effect(() => {
    const id = accountId;
    const enabled = account?.connectConsent;
    if (previousAccount !== id) { newMode = false; newRecipient = newDraft = ""; previousAccount = id; }
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
    unreadOnly = false;
    entryCursor = null;
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

  $effect(() => {
    const request = connect.request;
    if (!request) return;
    if (!app.ownAccounts.some(a => a.id === request.accountId)) {
      connect.request = null;
      return;
    }
    if (accountId !== request.accountId) { accountId = request.accountId; return; }
    if (!account?.connectConsent) return;
    untrack(() => {
      connect.request = null;
      if (request.conversation) {
        newMode = false; parent = null; rootMessage = null;
        select(request.conversation, request.messageId);
      } else {
        startNew(request.recipient, request.draft);
      }
    });
  });

  function startNew(recipient = "", initialDraft = "") {
    newRecipient = recipient;
    newDraft = initialDraft;
    wizardVersion++;
    newMode = true;
  }
  function created(chat: ConnectChat, initialDraft: string) {
    newMode = false; parent = null; rootMessage = null;
    select({ title: chatTitle(chat, accountId), resource: { kind: "chat", chatId: chat.id }, members: chat.members, webUrl: chat.webUrl });
    if (initialDraft) drafts[draftKey] = initialDraft;
    void loadList({ kind: "chats" });
  }
  function participants() {
    return (active?.members ?? parent?.members ?? []).filter(m => `ms-${m.userId}` !== accountId && m.email).map(m => ({ name: m.displayName, email: m.email! }));
  }
  function emailConversation() {
    if (!active || composer.open) return;
    composer.compose({ accountId, to: participants(), subject: active.title,
      bodyHtml: textToHtml(conversationText(messages.slice(-10)) + (active.webUrl ? `\n\nConversation: ${active.webUrl}` : "")) });
  }
  function planMeeting(brief = "") {
    if (!active) return;
    if (calendar.composerOpen) { toasts.show("Finish or close your current event draft first."); return; }
    calendar.openComposer({ accountId, subject: active.title === "Thread" ? parent?.title || "Conversation follow-up" : active.title,
      attendees: participants(), isOnline: true,
      body: (brief || conversationText(messages.slice(-10))) + (active.webUrl ? `\n\nConversation: ${active.webUrl}` : "") });
  }

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
  function rowConversation(row: ConnectChat | ConnectGroup): Conversation {
    return { title: rowTitle(row), webUrl: row.webUrl, members: "chatType" in row ? row.members : undefined,
      resource: listing.kind === "channels" ? { kind: "channel", teamId: listing.teamId, channelId: row.id } : { kind: "chat", chatId: row.id } };
  }
  function openPin(conversation: Conversation) {
    parent = null; rootMessage = null;
    select(conversation);
  }
  function hasDraft(row: ConnectChat | ConnectGroup) {
    return listing.kind !== "teams" && !!drafts[`${accountId}:${JSON.stringify(rowConversation(row).resource)}`]?.trim();
  }
  function choose(row: ConnectChat | ConnectGroup) {
    if (listing.kind === "teams") {
      groupTitle = rowTitle(row);
      void loadList({ kind: "channels", teamId: row.id });
    } else {
      parent = null;
      rootMessage = null;
      select(rowConversation(row));
    }
  }
  function select(conversation: Conversation, messageId?: string) {
    browsing = false;
    highlighted = messageId ?? null;
    active = conversation;
    const known = connect.read[connect.readKey(accountId, conversation.resource)] || receipt(conversation.resource);
    entryCursor = known ? currentCursor(conversation.resource) : null;
    messages = [];
    messageNext = null;
    messageError = sendError = "";
    olderLoading = false;
    void loadMessages(false, messageId);
    if (conversation.resource.kind === "chat" && !conversation.members) void loadMembers(conversation.resource.chatId);
  }
  async function loadMembers(chatId: string) {
    const id = accountId, epoch = accountEpoch;
    const resource: ConnectResource = { kind: "members", chatId };
    try {
      let members: NonNullable<ConnectChat["members"]> = [];
      let next: string | null = null;
      do {
        const page: GraphPage<NonNullable<ConnectChat["members"]>[number]> = await connectApi.list<NonNullable<ConnectChat["members"]>[number]>(id, resource, next);
        if (epoch !== accountEpoch || active?.resource.kind !== "chat" || active.resource.chatId !== chatId) return;
        members = [...members, ...page.value];
        next = page["@odata.nextLink"] ?? null;
      } while (next);
      if (active) active = { ...active, members };
    } catch (e) { if (epoch === accountEpoch && active?.resource.kind === "chat" && active.resource.chatId === chatId) messageError = `Could not load participants: ${errMsg(e)}`; }
  }
  function quote(message: ConnectMessage) {
    if (active?.resource.kind === "channel") replies(message);
    const text = message.body.contentType === "html" ? previewText(message.body.content) : message.body.content;
    drafts[draftKey] = `${message.from?.user?.displayName || "Teams"} wrote: “${text.slice(0, 2000)}”\n\n${drafts[draftKey] || ""}`;
  }
  async function loadMessages(silent = false, messageId?: string) {
    if (!active) return;
    const seq = ++messageSeq;
    const id = accountId;
    const resource = active.resource;
    const nearBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    messageLoading = true;
    try {
      const page = await connectApi.list<ConnectMessage>(id, resource);
      if (messageId && !page.value.some(m => m.id === messageId)) {
        page.value.push(await connectApi.message(id, resource, messageId));
      }
      if (seq !== messageSeq || id !== accountId) return;
      messages = mergeMessages(silent ? messages : [], page.value);
      if (entryCursor === null) entryCursor = readCursor(messages[messages.length - 1]?.createdDateTime);
      if (!silent) messageNext = page["@odata.nextLink"] ?? null;
      messageError = "";
      if (!silent || nearBottom) {
        await tick();
        if (seq === messageSeq && scroller) {
          if (messageId) scroller.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.scrollIntoView({ block: "center" });
          else if (!silent && firstUnread) scroller.querySelector(".unread-divider")?.scrollIntoView({ block: "start" });
          else scroller.scrollTop = scroller.scrollHeight;
        }
      }
    } catch (e) { if (seq === messageSeq) messageError = errMsg(e); }
    finally { if (seq === messageSeq) { messageLoading = false; readVisible(); } }
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
        if (key === draftKey && scroller) { scroller.scrollTop = scroller.scrollHeight; readVisible(); }
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

<svelte:document onvisibilitychange={readVisible} />
<svelte:window onfocus={readVisible} />
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
  {:else if newMode}
    {#key `${accountId}:${wizardVersion}`}<NewConversation {account} initialRecipient={newRecipient} initialDraft={newDraft} {consenting} onEnable={enable} onCancel={() => newMode = false} onCreated={created} />{/key}
  {:else}
    <div class="workspace" class:has-conversation={!!active} class:browsing>
      <div class="browser">
        <div class="tabs">
          <button class:chosen={listing.kind === "chats"} onclick={() => loadList({ kind: "chats" })}><MessageCircle size={14} />Chats</button>
          <button class:chosen={listing.kind !== "chats"} onclick={() => loadList({ kind: "teams" })}><Hash size={14} />Channels</button>
          <button class="icon-btn" aria-label="New conversation" title="New conversation" onclick={() => startNew()}><Plus size={15} /></button>
          <button class="icon-btn refresh" disabled={listLoading} aria-label="Refresh conversations" onclick={() => loadList(listing)}><RefreshCw size={13} class={listLoading ? "spin" : ""} /></button>
        </div>
        {#if listing.kind === "channels"}<button class="group-back" onclick={() => loadList({ kind: "teams" })}><ArrowLeft size={13} />{groupTitle}</button>{/if}
        <input class="filter" aria-label="Filter loaded conversations" placeholder="Find a conversation…" bind:value={filter} />
        {#if listing.kind === "chats"}
          <div class="read-filters" aria-label="Conversation read status">
            <button class:chosen={!unreadOnly} aria-pressed={!unreadOnly} onclick={() => unreadOnly = false}>All</button>
            <button class:chosen={unreadOnly} aria-pressed={unreadOnly} onclick={() => unreadOnly = true}>Unread{#if unreadCount}<span class="badge">{unreadCount}</span>{/if}</button>
          </div>
        {/if}
        {#if listError}<p class="error" role="alert">{listError}</p>{/if}
        <div class="conversations">
          {#if pins.length}
            <div class="section-label">Pinned</div>
            {#each pins as pin (JSON.stringify(pin.conversation.resource))}
              <div class="conversation-row">
                <button class="conversation pinned" class:selected={JSON.stringify(active?.resource) === JSON.stringify(pin.conversation.resource)} onclick={() => openPin(pin.conversation)}>
                  <Pin size={13} /><span class="conversation-copy"><strong>{pin.conversation.title}</strong></span>
                </button>
                <button class="pin-action icon-btn" aria-label={`Unpin ${pin.conversation.title}`} title="Unpin conversation" onclick={() => connect.togglePin(accountId, pin.conversation)}><PinOff size={12} /></button>
              </div>
            {/each}
            <div class="section-label">{listing.kind === "chats" ? "Chats" : "Channels"}</div>
          {/if}
          {#each visibleRows as row (row.id)}
            {@const selected = active?.resource.kind === "chat" ? active.resource.chatId === row.id : active?.resource.kind === "channel" ? active.resource.channelId === row.id : false}
            <div class="conversation-row">
            <button class="conversation" class:selected class:unread={rowUnread(row)} aria-label={`${rowTitle(row)}${rowUnread(row) ? ", unread" : ""}`} onclick={() => choose(row)}>
              <span class="conversation-icon">{#if "chatType" in row}<MessageCircle size={16} />{:else}<Hash size={16} />{/if}</span>
              <span class="conversation-copy"><strong>{rowTitle(row)}{#if hasDraft(row)}<em>Draft</em>{/if}</strong>
                {#if "chatType" in row}<small>{previewText(row.lastMessagePreview?.body?.content || "") || (row.chatType === "meeting" ? "Meeting chat" : "Open conversation")}</small>{/if}
              </span>
              {#if rowUnread(row)}<span class="unread-dot" title="Unread messages" aria-label="Unread messages"></span>{/if}
            </button>
            {#if listing.kind !== "teams"}
              {@const pinned = connect.isPinned(accountId, rowConversation(row).resource)}
              <button class="pin-action icon-btn" class:is-pinned={pinned} aria-label={`${pinned ? "Unpin" : "Pin"} ${rowTitle(row)}`} title={pinned ? "Unpin conversation" : "Pin conversation"} onclick={() => connect.togglePin(accountId, rowConversation(row))}>{#if pinned}<PinOff size={12} />{:else}<Pin size={12} />{/if}</button>
            {/if}
            </div>
          {:else}<p class="empty">{listLoading ? "Loading conversations…" : filter ? "No matching conversations." : listError ? "Conversations couldn’t be loaded." : unreadOnly && listing.kind === "chats" ? "You’re caught up on loaded chats." : listing.kind === "teams" ? "No joined teams found." : "No conversations found."}</p>{/each}
          {#if listNext}<button class="load-more" disabled={listLoading} onclick={() => loadList(listing, true)}>Load more conversations</button>{/if}
        </div>
      </div>
      <div class="conversation-pane">
        {#if active}
          <div class="conversation-heading">
            {#if !parent}<button class="icon-btn conversation-switch" aria-label="Back to conversations" title="Back to conversations" onclick={() => browsing = true}><ArrowLeft size={16} /></button>{/if}
            {#if parent}<button class="icon-btn" aria-label="Back to channel" onclick={() => { const p = parent!; parent = null; rootMessage = null; select(p); }}><ArrowLeft size={16} /></button>{/if}
            <div><strong>{active.title}</strong><small>{parent?.title || (active.resource.kind === "channel" ? "Channel posts" : "Microsoft Teams conversation")}</small></div>
            {#if active.resource.kind === "chat" || active.resource.kind === "channel"}<button class="icon-btn" class:on={connect.isPinned(accountId, active.resource)} aria-label={connect.isPinned(accountId, active.resource) ? "Unpin conversation" : "Pin conversation"} title="Keep this conversation in Pinned" onclick={() => active && connect.togglePin(accountId, active)}><Pin size={14} /></button>{/if}
            <button class="icon-btn" disabled={messageLoading || olderLoading} aria-label="Refresh messages" onclick={() => loadMessages(true)}><RefreshCw size={14} class={messageLoading ? "spin" : ""} /></button>
            <button class="icon-btn" title="Open in Teams for calls, files, and more" aria-label="Open conversation in Teams" onclick={() => external()}><ExternalLink size={14} /></button>
          </div>
          <div class="bridges">
            <button title={composer.open ? "Finish your current email draft first" : "Draft an email from this conversation"} disabled={composer.open} onclick={emailConversation}><Mail size={12} /> Email</button>
            <button onclick={() => planMeeting()}><CalendarPlus size={12} /> Plan meeting</button>
            <button onclick={() => { search.accountId = accountId; search.tab = "all"; void search.run(active?.title || ""); }}><Search size={12} /> Related</button>
          </div>
          {#if messageError}<p class="error" role="alert">{messageError}</p>{/if}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="messages" bind:this={scroller} onclick={bodyLink} onscroll={readVisible}>
            {#if rootMessage}<div class="thread-root"><strong>{rootMessage.from?.user?.displayName || "Channel post"}</strong><p>{previewText(rootMessage.body.content)}</p></div>{/if}
            {#if messageNext}<button class="load-more" disabled={olderLoading || messageLoading} onclick={older}>{olderLoading ? "Loading…" : "Load more messages"}</button>{/if}
            {#each messages as message (message.id)}
              {#if message.id === firstUnread?.id}<div class="unread-divider" role="separator" aria-label="New messages"><span>New messages</span></div>{/if}
              <article class="message" data-message-id={message.id} class:highlighted={message.id === highlighted} class:mine={`ms-${message.from?.user?.id}` === accountId}>
                <div class="message-meta"><strong>{message.from?.user?.displayName || message.from?.application?.displayName || "Teams"}</strong><time datetime={message.createdDateTime}>{when(message.createdDateTime)}</time></div>
                {#if message.deletedDateTime}<p class="deleted">Message deleted</p>
                {:else}
                  {#if message.subject}<strong>{message.subject}</strong>{/if}
                  {#if message.body.contentType === "html"}<div class="message-body">{@html safeBody(message.body.content)}</div>
                  {:else}<div class="message-body plain">{message.body.content || "Activity in Teams"}</div>{/if}
                  {#if message.lastEditedDateTime}<small class="edited">Edited</small>{/if}
                  {#if message.attachments?.length}<button class="text-btn" onclick={() => external(message.webUrl || active?.webUrl)}>Open {message.attachments.length} attachment(s) in Teams <ExternalLink size={11} /></button>{/if}
                  <button class="text-btn" onclick={() => quote(message)}>Quote in reply</button>
                  {#if active.resource.kind === "channel"}<button class="text-btn" onclick={() => replies(message)}>View thread / reply</button>{/if}
                {/if}
              </article>
            {:else}<p class="empty">{messageLoading ? "Loading messages…" : messageError ? "Messages couldn’t be loaded." : "No messages yet. Start the conversation below."}</p>{/each}
          </div>
          {#if pending.length && !messageLoading}<button class="new-messages" type="button" onclick={jumpToLatest}>{pending.length} new {pending.length === 1 ? "message" : "messages"} · Jump to latest ↓</button>{/if}
          <form class="compose" onsubmit={(e) => { e.preventDefault(); void send(); }}>
            {#key draftKey}
              <ConnectAssistant {account} conversation={active} messages={rootMessage ? [rootMessage, ...messages] : messages} {draft} onUse={(text) => drafts[draftKey] = text} onPlan={planMeeting} />
            {/key}
            {#if sendError}<p class="error" role="alert">{sendError}</p>{/if}
            <textarea bind:this={messageEditor} aria-label="Message" placeholder={active.resource.kind === "channel" ? "Start a new channel post…" : "Write a message…"} value={draft} oninput={(e) => drafts[draftKey] = e.currentTarget.value} rows="3" maxlength="20000"
              onkeydown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void send(); } }}></textarea>
            <div class="compose-footer"><EmojiPicker onSelect={addEmoji} /><span>Ctrl + Enter to send</span><button class="btn primary" disabled={!draft.trim() || sending} type="submit"><Send size={13} />{sending ? "Sending…" : "Send"}</button></div>
          </form>
        {:else}<div class="empty-state"><MessageCircle size={32} /><h3>Keep the conversation close</h3><p>Choose a chat or channel. Your mail and calendar stay right beside it.</p><button class="btn primary" onclick={() => startNew()}><Plus size={13} /> New conversation</button></div>{/if}
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
  .section-label { padding: 10px 9px 5px; font-size: 10px; font-weight: 600; color: var(--muted); letter-spacing: .05em; text-transform: uppercase; }
  .conversation-row { display: flex; align-items: center; position: relative; }
  .conversation-row .conversation { min-width: 0; padding-right: 32px; }
  .pin-action { position: absolute; right: 2px; opacity: 0; width: 26px; }
  .conversation-row:hover .pin-action, .conversation-row:focus-within .pin-action, .pin-action.is-pinned { opacity: 1; }
  .pinned { color: var(--fg-dim); }
  .conversation-copy em { font-style: normal; color: var(--accent); font-size: 10px; margin-left: 7px; }
  .conversation { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px; text-align: left; border-radius: 7px; }
  .conversation:hover { background: var(--panel); }
  .conversation.selected { background: var(--accent-soft); }
  .conversation-icon { color: var(--muted); display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--panel); flex: none; }
  .conversation-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; flex: 1; }
  .conversation.unread .conversation-copy strong { color: var(--fg-bright); font-weight: 700; }
  .unread-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .read-filters { display: flex; gap: 5px; padding: 0 14px 8px; }
  .read-filters button { display: flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 4px; font-size: 11px; color: var(--muted); }
  .read-filters .chosen { background: var(--hover); color: var(--fg-bright); box-shadow: inset 0 -2px var(--accent); }
  .badge { font-size: 10px; font-weight: 600; }
  .unread-divider { display: flex; align-items: center; gap: 10px; color: var(--accent); font-size: 10px; margin: 0 0 16px; scroll-margin-top: 12px; }
  .unread-divider::before, .unread-divider::after { content: ""; height: 1px; flex: 1; background: var(--accent-line); }
  .new-messages { align-self: center; margin: 0 12px 8px; padding: 6px 12px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; }
  .conversation-copy strong { font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conversation-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-back { display: flex; align-items: center; gap: 6px; padding: 0 16px 9px; font-size: 12px; color: var(--muted); }
  .conversation-pane { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .conversation-switch { display: none; }
  .bridges { display: flex; gap: 12px; padding: 5px 14px 9px; border-bottom: 1px solid var(--line); }
  .bridges button { display: flex; gap: 5px; align-items: center; font-size: 11px; color: var(--accent); }
  .conversation-heading { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .conversation-heading > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .conversation-heading strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; overflow-wrap: anywhere; user-select: text; }
  .message { margin: 0 0 18px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .message.highlighted { outline: 2px solid var(--accent); outline-offset: 3px; }
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
  .compose { flex: none; max-height: 58%; overflow-y: auto; border-top: 1px solid var(--line); padding: 12px; }
  textarea { width: 100%; resize: vertical; max-height: 200px; min-height: 64px; box-sizing: border-box; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; color: var(--fg); font-family: inherit; font-size: 13px; }
  textarea:focus { outline: 1px solid var(--accent); }
  .compose-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 8px; }
  .compose-footer span { font-size: 10px; color: var(--muted); }
  .compose-footer .primary { margin-left: auto; }
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
  @container (max-width: 699px) {
    .browser, .workspace:not(.has-conversation) .browser { flex: 1; max-height: none; border-bottom: 0; }
    .has-conversation:not(.browsing) .browser { display: none; }
    .browsing .conversation-pane, .workspace:not(.has-conversation) .conversation-pane { display: none; }
    .conversation-switch { display: inline-grid; }
  }
</style>
