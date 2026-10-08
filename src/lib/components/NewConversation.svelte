<script lang="ts">
  import { onDestroy } from "svelte";
  import { connectApi, type ConnectChat, type ConnectPerson } from "$lib/connect";
  import type { Account } from "$lib/types";
  import { errMsg } from "$lib/util/misc";
  import { UserPlus, X, Search, Users } from "@lucide/svelte";
  let { account, initialRecipient = "", initialDraft = "", onCreated, onCancel, onEnable, consenting }: {
    account: Account; initialRecipient?: string; initialDraft?: string;
    onCreated: (chat: ConnectChat, draft: string) => void; onCancel: () => void; onEnable: () => void; consenting: boolean;
  } = $props();
  // Initial values belong to this wizard; changing the account remounts it.
  // svelte-ignore state_referenced_locally
  let query = $state(initialRecipient);
  // svelte-ignore state_referenced_locally
  let starter = $state(initialDraft);
  let people = $state<ConnectPerson[]>([]);
  let chosen = $state<ConnectPerson[]>([]);
  let topic = $state("");
  let finding = $state(false);
  let creating = $state(false);
  let lookupError = $state("");
  let createError = $state("");
  let seq = 0;
  let alive = true;
  onDestroy(() => { alive = false; seq++; });
  $effect(() => {
    const q = query.trim(), id = account.id, allowed = account.connectComposeConsent;
    const generation = ++seq;
    people = []; lookupError = ""; finding = false;
    if (!allowed || q.length < 2) return;
    finding = true;
    const timer = setTimeout(async () => {
      try {
        const page = await connectApi.people(id, q);
        if (generation === seq && alive) people = page.value.filter(p => `ms-${p.id}` !== id);
      } catch (e) { if (generation === seq && alive) lookupError = errMsg(e); }
      finally { if (generation === seq && alive) finding = false; }
    }, 250);
    return () => { clearTimeout(timer); };
  });
  function add(person: ConnectPerson) {
    if (chosen.length < 20 && !chosen.some(p => p.id === person.id)) chosen = [...chosen, person];
    query = "";
  }
  async function create() {
    if (creating || !chosen.length) return;
    creating = true; createError = "";
    try {
      const chat = await connectApi.createChat(account.id, chosen.map(p => p.id), topic);
      if (alive) onCreated(chat, starter);
    } catch (e) { if (alive) createError = `${errMsg(e)} If the connection was interrupted, check your chats before trying again.`; }
    finally { if (alive) creating = false; }
  }
</script>
<section class="new-conversation" aria-label="New conversation">
  <header><UserPlus size={20} /><div><h2>Start a conversation</h2><p>Bring the right people together.</p></div><button class="icon-btn" aria-label="Cancel new conversation" disabled={creating} onclick={onCancel}><X size={17} /></button></header>
  {#if !account.connectComposeConsent}
    <div class="permission"><Users size={28} /><h3>Meet someone new</h3><p>Allow Tern to find people in your organization and create chats. Existing conversations keep working with your current permissions.</p><button class="btn primary" disabled={consenting} onclick={onEnable}>{consenting ? "Waiting for Microsoft…" : "Enable new conversations"}</button></div>
  {:else}
    <label for="connect-people">To <small>{chosen.length > 1 ? "Group conversation" : "One-to-one conversation"}</small></label>
    <div class="chosen">{#each chosen as person (person.id)}<button disabled={creating} onclick={() => chosen = chosen.filter(p => p.id !== person.id)} title="Remove {person.displayName}">{person.displayName}<X size={11} /></button>{/each}</div>
    <div class="find"><Search size={14} /><input id="connect-people" aria-label="Find people" placeholder="Name or email address…" bind:value={query} disabled={creating || chosen.length >= 20} /></div>
    {#if lookupError}<p class="error" role="alert">{lookupError}</p>{/if}
    <div class="people">{#each people.filter(p => !chosen.some(c => c.id === p.id)) as person (person.id)}<button class="person" disabled={creating} onclick={() => add(person)}><span class="initial">{person.displayName?.slice(0, 1) || "?"}</span><span><strong>{person.displayName}</strong><small>{person.mail || person.userPrincipalName}</small></span><UserPlus size={14} /></button>
      {:else}<p class="hint">{finding ? "Finding people…" : query.trim().length >= 2 ? "No matching people. Try their full email or directory name." : "Search your organization by name or email. You can add up to 20 people."}</p>{/each}</div>
    {#if chosen.length > 1}<label for="connect-topic">Conversation name</label><input id="connect-topic" bind:value={topic} maxlength="250" placeholder="e.g. Autumn launch" disabled={creating} />{/if}
    {#if starter}<label for="connect-starter">Message draft <small>Review and send after opening the chat</small></label><textarea id="connect-starter" bind:value={starter} rows="5" disabled={creating}></textarea>{/if}
    {#if createError}<p class="error" role="alert">{createError}</p>{/if}
    <footer><button class="btn" disabled={creating} onclick={onCancel}>Cancel</button><button class="btn primary" disabled={!chosen.length || creating} onclick={create}>{creating ? "Opening…" : chosen.length > 1 ? "Create group conversation" : "Open conversation"}</button></footer>
    <p class="hint">An existing one-to-one chat is reused. No message is sent until you press Send.</p>
  {/if}
</section>
<style>
  .new-conversation { padding: 22px; overflow-y: auto; flex: 1; }
  header { display: flex; align-items: center; gap: 12px; color: var(--accent); margin-bottom: 24px; }
  header div { flex: 1; }
  h2 { margin: 0; font-size: 20px; letter-spacing: -.03em; color: var(--fg-bright); }
  header p { margin: 5px 0 0; font-size: 12px; color: var(--muted); }
  label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; font-weight: 550; margin: 16px 0 8px; }
  small { font-size: 10px; color: var(--muted); font-weight: normal; }
  input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--fg); padding: 10px; font: inherit; font-size: 12px; }
  .find { display: flex; align-items: center; gap: 8px; color: var(--muted); }
  .find input { flex: 1; min-width: 0; }
  .chosen { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .chosen button { display: flex; align-items: center; gap: 5px; color: var(--accent); background: var(--accent-soft); padding: 6px 9px; border-radius: 20px; font-size: 11px; }
  .people { margin-top: 10px; max-height: 260px; overflow-y: auto; }
  .person { display: flex; align-items: center; gap: 10px; padding: 9px; border-radius: 8px; width: 100%; text-align: left; }
  .person:hover { background: var(--accent-soft); }
  .person > span:not(.initial) { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
  .person strong { font-size: 12px; }
  .initial { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--panel); color: var(--accent); }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
  .hint, .permission p { color: var(--muted); font-size: 11px; line-height: 1.6; }
  .permission { text-align: center; padding: 30px 8px; }
  .permission h3 { font-size: 17px; }
  .error { color: var(--red); font-size: 12px; line-height: 1.5; }
  button:disabled { opacity: .5; }
</style>
