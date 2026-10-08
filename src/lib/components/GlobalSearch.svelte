<script lang="ts">
  import { search, type SearchKind } from "$lib/state/search.svelte";
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import { connect } from "$lib/state/connect.svelte";
  import { previewText, searchConversation, type ConnectSearchHit } from "$lib/connect";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { errMsg } from "$lib/util/misc";
  import { Mail, CalendarDays, MessageCircle, Search, X, ArrowUpRight } from "@lucide/svelte";
  import type { CalEvent, MessageSummary } from "$lib/types";
  let opening = $state(false);
  let error = $state("");
  const tabs: { id: SearchKind; label: string }[] = [{ id: "all", label: "Everything" }, { id: "mail", label: "Mail" }, { id: "calendar", label: "Calendar" }, { id: "connect", label: "Connect" }];
  const count = $derived(search.mail.length + search.events.length + search.conversations.reduce((n, a) => n + a.hits.length, 0));
  const busy = $derived(search.mailLoading || search.calendarLoading || search.conversations.some(a => a.loading));
  function date(value?: string) { return value ? new Date(value).toLocaleString(app.settings?.ui.locale ?? "en-GB", { dateStyle: "medium", timeStyle: "short", hour12: false }) : ""; }
  async function mail(message: MessageSummary) {
    if (opening) return;
    opening = true; error = "";
    try {
      app.view = { kind: "results", title: `Search: ${search.query}`, ids: search.mail.map(m => m.id) };
      connect.expanded = false;
      await app.reload();
      app.selectedId = message.id;
      await app.openMessage(message.id);
      if (!app.readingPane) await app.openInWindow(message.id);
      search.close();
    } catch (e) { error = errMsg(e); }
    finally { opening = false; }
  }
  function event(ev: CalEvent) {
    connect.expanded = false;
    app.setView({ kind: "calendar" });
    calendar.jumpTo(ev);
    search.close();
  }
  async function conversation(accountId: string, hit: ConnectSearchHit) {
    const target = searchConversation(hit);
    if (target) {
      connect.show({ accountId, conversation: target, messageId: hit.resource.id });
      search.close();
    } else {
      try {
        const url = new URL(hit.resource.webUrl ?? "");
        if (url.protocol !== "https:") throw new Error("This result has no conversation link");
        await openUrl(url.href);
      } catch (e) { error = errMsg(e); }
    }
  }
</script>

{#if search.open}
  <section class="global-search" aria-label="Search results" data-global-search>
    <header>
      <div class="title"><Search size={22} /><div><h1>Find it across your day</h1><p>{busy ? "Searching" : `${count} results loaded`} for “{search.query}”</p></div></div>
      <select aria-label="Search account" value={search.accountId ?? ""} onchange={(e) => { search.accountId = e.currentTarget.value || null; void search.run(search.query); }}>
        <option value="">All accounts</option>{#each app.accounts as a (a.id)}<option value={a.id}>{a.email}</option>{/each}
      </select>
      <button class="icon-btn" aria-label="Close search" onclick={() => search.close()}><X size={19} /></button>
    </header>
    <nav aria-label="Search categories">{#each tabs as tab}<button class:active={search.tab === tab.id} onclick={() => search.tab = tab.id}>{tab.label}</button>{/each}</nav>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="results">
      {#if search.tab === "all" || search.tab === "mail"}
        <section class="source"><h2><Mail size={16} /> Mail <small>{search.mail.length}{search.mailMore ? "+" : ""} · downloaded mail</small></h2>
          {#if search.mailError}<p class="error" role="alert">{search.mailError} <button onclick={() => search.run(search.query)}>Retry search</button></p>{/if}
          {#each search.mail as m (m.id)}<button class="result" disabled={opening} onclick={() => mail(m)}><div class="result-top"><strong>{m.subject || "(no subject)"}</strong><time>{date(m.receivedAt)}</time></div><span>{m.from.name || m.from.email} · {app.accountById.get(m.accountId)?.email}</span><p>{m.preview}</p></button>
          {:else}<p class="empty">{search.mailLoading ? "Searching mail…" : search.mailError ? "Mail search unavailable." : "No matching mail."}</p>{/each}
          {#if search.mailMore}<button class="btn more" disabled={search.mailLoading} onclick={() => search.moreMail()}>More mail</button>{/if}
        </section>
      {/if}
      {#if search.tab === "all" || search.tab === "calendar"}
        <section class="source"><h2><CalendarDays size={16} /> Calendar <small>{search.events.length}{search.events.length === 200 ? "+" : ""} · downloaded dates</small></h2>
          {#if search.calendarError}<p class="error" role="alert">{search.calendarError} <button onclick={() => search.run(search.query)}>Retry search</button></p>{/if}
          {#each search.events as ev (ev.id)}<button class="result" onclick={() => event(ev)}><div class="result-top"><strong>{ev.subject || "(no title)"}</strong><time>{date(ev.start)}</time></div><span>{ev.location || (ev.isOnline ? "Online meeting" : "Event")} · {app.accountById.get(ev.accountId)?.email}</span><p>{ev.preview}</p></button>
          {:else}<p class="empty">{search.calendarLoading ? "Searching calendar…" : search.calendarError ? "Calendar search unavailable." : "No matches in downloaded calendar dates."}</p>{/each}
          {#if search.events.length === 200}<p class="empty">Showing 200 closest matches. Refine your search for more specific results.</p>{/if}
        </section>
      {/if}
      {#if search.tab === "all" || search.tab === "connect"}
        <section class="source"><h2><MessageCircle size={16} /> Connect <small>Live Microsoft Teams search</small></h2>
          {#each search.conversations as a (a.accountId)}
            <h3>{app.accountById.get(a.accountId)?.email}</h3>
            {#if a.error}<p class="error" role="alert">{a.error} <button onclick={() => search.loadConnect(a.accountId)}>Retry</button></p>{/if}
            {#each a.hits as hit (hit.hitId)}<button class="result" onclick={() => conversation(a.accountId, hit)}><div class="result-top"><strong>{hit.resource.subject || hit.resource.from?.user?.displayName || hit.resource.from?.emailAddress?.name || "Conversation message"}</strong><time>{date(hit.resource.createdDateTime)}</time></div><span>{hit.resource.channelIdentity?.channelId ? "Channel" : "Chat"} <ArrowUpRight size={11} /></span><p>{previewText(hit.summary) || "Open this message in its conversation"}</p></button>
            {:else}<p class="empty">{a.loading ? "Searching conversations…" : a.error ? "Connect search unavailable for this account." : "No matching conversations."}</p>{/each}
            {#if a.more}<button class="btn more" disabled={a.loading} onclick={() => search.loadConnect(a.accountId, true)}>More Connect results</button>{/if}
          {:else}<p class="empty">Enable Connect on a work or school account to include its conversations.</p><button class="btn" onclick={() => { connect.open = true; connect.expanded = false; search.close(); }}>Open Connect</button>{/each}
          <p class="hint">Microsoft’s search index may take a moment to include recent messages.</p>
        </section>
      {/if}
    </div>
  </section>
{/if}

<style>
  .global-search { position: fixed; inset: 46px 0 0; z-index: 25; background: var(--surface); display: flex; flex-direction: column; min-height: 0; }
  header { display: flex; align-items: center; gap: 18px; padding: 22px 30px 12px; }
  .title { display: flex; align-items: center; gap: 14px; flex: 1; color: var(--accent); }
  h1 { font-size: 22px; letter-spacing: -.04em; color: var(--fg-bright); margin: 0; }
  .title p { margin: 5px 0 0; font-size: 12px; color: var(--muted); }
  select { max-width: 260px; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; color: var(--fg); padding: 8px; }
  nav { display: flex; gap: 8px; padding: 0 30px 16px; border-bottom: 1px solid var(--line); }
  nav button { padding: 7px 14px; border-radius: 7px; font-size: 12px; color: var(--muted); }
  nav button.active { background: var(--accent-soft); color: var(--accent); }
  .results { overflow-y: auto; padding: 22px 30px; }
  .source { max-width: 1050px; margin: 0 auto 28px; }
  h2 { display: flex; align-items: center; gap: 8px; font-size: 15px; margin: 0 0 12px; }
  h2 small { font-size: 11px; font-weight: normal; color: var(--muted); margin-left: auto; }
  h3 { font-size: 11px; font-weight: 500; color: var(--muted); }
  .result { display: block; width: 100%; text-align: left; padding: 13px 16px; margin-bottom: 7px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .result:hover, .result:focus-visible { border-color: var(--accent-line); background: var(--accent-soft); }
  .result-top { display: flex; align-items: baseline; gap: 12px; }
  .result strong { font-weight: 550; font-size: 13px; }
  time { margin-left: auto; flex: none; font-size: 11px; color: var(--muted); }
  .result span { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11px; color: var(--muted); }
  .result p { font-size: 12px; line-height: 1.5; margin: 7px 0 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .empty, .hint { color: var(--muted); font-size: 12px; padding: 8px 0; }
  .hint { font-size: 11px; }
  .error { color: var(--red); font-size: 12px; padding: 8px 20px; }
  .error button { text-decoration: underline; }
  .more { margin-top: 8px; }
</style>
