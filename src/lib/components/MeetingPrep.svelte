<script lang="ts">
  // Meeting prep: related mail from the people in the meeting (local full-text search), then a streamed AI brief.
  // Appears inside the event details the moment it opens — no clicks.
  import { app } from "$lib/state/app.svelte";
  import { api } from "$lib/api";
  import { prepMeeting, isAbort } from "$lib/ai";
  import type { CalEvent, MessageFull, MessageSummary } from "$lib/types";
  import { md, mdLinkHandler } from "$lib/util/markdown";
  import { shortTime } from "$lib/util/time";
  import { displayName, errMsg } from "$lib/util/misc";
  import { Sparkles, Mail, Paperclip, LoaderCircle, RefreshCw, ChevronDown, ChevronUp } from "@lucide/svelte";

  let { ev }: { ev: CalEvent } = $props();

  let related = $state<MessageSummary[]>([]);
  let searching = $state(false);
  let brief = $state("");
  let briefBusy = $state(false);
  let briefError = $state<string | null>(null);
  let open = $state(true);
  let ctrl: AbortController | null = null;
  let forId = "";
  /** Brief per event id for this session so re-opening is instant. */
  const cache = new Map<string, { brief: string; related: MessageSummary[] }>();

  $effect(() => {
    const id = ev.id;
    if (id === forId) return;
    forId = id;
    ctrl?.abort();
    const c = cache.get(id);
    if (c) {
      related = c.related;
      brief = c.brief;
      briefError = null;
      return;
    }
    brief = "";
    briefError = null;
    load(ev);
  });

  function subjectWords(s: string): string {
    return s
      .replace(/^(re|sv|fw|fwd|vb):\s*/i, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !/^(möte|meeting|call|sync|with|med|and|och|the|för|about|update|weekly|monthly)$/i.test(w))
      .slice(0, 4)
      .join(" ");
  }

  async function load(e: CalEvent) {
    searching = true;
    const me = new Set(app.accounts.map((a) => a.email.toLowerCase()));
    const people = [...(e.organizer ? [e.organizer] : []), ...e.attendees.map((a) => a.addr)]
      .map((a) => a.email.toLowerCase())
      .filter((x, i, arr) => x && !me.has(x) && arr.indexOf(x) === i)
      .slice(0, 6);
    const queries = [subjectWords(e.subject), ...people.map((p) => p.split("@")[0])].filter((q) => q.length >= 3);
    try {
      const lists = await Promise.all(queries.map((q) => api.messages({ view: { kind: "search", query: q }, accountId: e.accountId, limit: 6 }).catch(() => [] as MessageSummary[])));
      const seen = new Set<string>();
      const merged: MessageSummary[] = [];
      for (const list of lists)
        for (const m of list)
          if (!seen.has(m.conversationId || m.id)) {
            seen.add(m.conversationId || m.id);
            merged.push(m);
          }
      merged.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      if (forId !== e.id) return;
      related = merged.slice(0, 6);
    } finally {
      if (forId === e.id) searching = false;
    }
    if (app.aiReady) runBrief(e);
  }

  async function runBrief(e: CalEvent) {
    ctrl?.abort();
    const c = new AbortController();
    ctrl = c;
    briefBusy = true;
    briefError = null;
    brief = "";
    let acc = "";
    try {
      const full: MessageFull[] = (await Promise.all(related.slice(0, 4).map((m) => api.message(m.id).catch(() => null)))).filter((m): m is MessageFull => !!m);
      for await (const d of prepMeeting(e, full, c.signal)) {
        if (c.signal.aborted) break;
        acc += d;
        brief = acc;
      }
      if (!c.signal.aborted) cache.set(e.id, { brief: acc, related });
    } catch (err) {
      if (!isAbort(err) && !c.signal.aborted) briefError = errMsg(err);
    } finally {
      if (ctrl === c) briefBusy = false;
    }
  }

  function openMail(m: MessageSummary) {
    app.select(m.id);
  }
</script>

{#if related.length || searching || app.aiReady}
  <section class="prep" class:open>
    <button class="head" onclick={() => (open = !open)}>
      <Sparkles size={13} class="spark" />
      <span class="t">Prep</span>
      {#if searching || briefBusy}<LoaderCircle size={12} class="spin" />{/if}
      <span class="spacer"></span>
      {#if related.length}<span class="n mono">{related.length} related</span>{/if}
      {#if open}<ChevronUp size={13} />{:else}<ChevronDown size={13} />{/if}
    </button>
    {#if open}
      <div class="body">
        {#if app.aiReady}
          {#if brief}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="md brief" class:streaming={briefBusy} onclick={mdLinkHandler}>{@html md(brief)}</div>
          {:else if briefBusy}
            <div class="skeleton"><span style:width="70%"></span><span style:width="90%"></span><span style:width="55%"></span></div>
          {:else if briefError}
            <div class="err">{briefError} <button class="lnk" onclick={() => runBrief(ev)}><RefreshCw size={11} /> retry</button></div>
          {/if}
        {/if}
        {#if related.length}
          <ul class="mails">
            {#each related as m (m.id)}
              <li>
                <button class="mail" onclick={() => openMail(m)}>
                  <Mail size={12} />
                  <span class="who">{displayName(m.from)}</span>
                  <span class="subj">{m.subject || "(no subject)"}</span>
                  {#if m.hasAttachments}<Paperclip size={11} class="clip" />{/if}
                  <time class="mono">{shortTime(m.receivedAt)}</time>
                </button>
              </li>
            {/each}
          </ul>
        {:else if !searching}
          <div class="none">No related mail found.</div>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .prep {
    border-radius: 12px;
    background: linear-gradient(135deg, color-mix(in oklab, var(--accent) 9%, transparent), color-mix(in oklab, var(--magenta) 5%, transparent));
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 22%, var(--line));
    animation: fade-up 260ms var(--ease);
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 10px;
    color: var(--accent);
  }
  .head :global(.spark) {
    animation: twinkle 2.4s ease-in-out infinite;
  }
  @keyframes twinkle {
    50% {
      opacity: 0.5;
      transform: scale(0.9) rotate(10deg);
    }
  }
  .t {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .spacer {
    flex: 1;
  }
  .n {
    font-size: 10.5px;
    color: var(--muted);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 10px 10px;
  }
  .brief {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--fg);
  }
  .brief :global(p) {
    margin: 0 0 4px;
  }
  .brief :global(ul) {
    margin: 2px 0 4px;
    padding-left: 18px;
  }
  .brief :global(li) {
    margin: 1px 0;
  }
  .brief.streaming :global(p:last-child)::after,
  .brief.streaming :global(li:last-child)::after {
    content: "▍";
    color: var(--accent);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 2px 0;
  }
  .skeleton span {
    height: 10px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--hover) 25%, color-mix(in oklab, var(--accent) 18%, transparent) 50%, var(--hover) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }
  .err {
    font-size: 12px;
    color: var(--red);
  }
  .lnk {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent);
    font-size: 12px;
  }
  .mails {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .mail {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 6px;
    border-radius: 7px;
    font-size: 12px;
    color: var(--fg-dim);
    text-align: left;
    min-width: 0;
    transition: background var(--t);
  }
  .mail:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .who {
    flex: none;
    max-width: 120px;
    font-weight: 600;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subj {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mail :global(.clip) {
    flex: none;
    color: var(--muted);
  }
  .mail time {
    flex: none;
    font-size: 10.5px;
    color: var(--muted);
  }
  .none {
    font-size: 12px;
    color: var(--muted);
  }
</style>
