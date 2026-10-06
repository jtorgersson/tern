<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { api } from "$lib/api";
  import { hueColor } from "$lib/theme";
  import { relative } from "$lib/util/time";
  import { errMsg } from "$lib/util/misc";
  import type { AiProvider } from "$lib/types";
  import ProviderEditor from "./ProviderEditor.svelte";
  import { X, Users, Sparkles, Palette, PenLine, RefreshCw, Plus, Trash2, Pencil, LoaderCircle, Check } from "@lucide/svelte";

  const SECTIONS = [
    { id: "accounts", label: "Accounts", icon: Users },
    { id: "ai", label: "AI", icon: Sparkles },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "signatures", label: "Signatures", icon: PenLine },
    { id: "sync", label: "Sync", icon: RefreshCw },
  ] as const;

  let editing = $state<string | "new" | null>(null);
  let adding = $state(false);
  let renaming = $state<string | null>(null);
  let renameText = $state("");
  let confirmRemove = $state<string | null>(null);

  const s = $derived(app.settings);

  async function addAccount() {
    if (!s?.microsoft.clientId) {
      toasts.error("Set the Microsoft client ID first");
      return;
    }
    adding = true;
    await app.addMicrosoftAccount();
    adding = false;
  }

  async function saveProvider(p: AiProvider) {
    await app.patchSettings((st) => {
      const i = st.ai.providers.findIndex((x) => x.id === p.id);
      if (i >= 0) st.ai.providers[i] = p;
      else st.ai.providers.push(p);
      if (!st.ai.defaultProviderId) st.ai.defaultProviderId = p.id;
    });
  }

  async function removeProvider(id: string) {
    await api.secretSet(`ai:${id}`, null).catch(() => {});
    await app.patchSettings((st) => {
      st.ai.providers = st.ai.providers.filter((p) => p.id !== id);
      if (st.ai.defaultProviderId === id) st.ai.defaultProviderId = st.ai.providers[0]?.id ?? null;
      if (st.ai.triageProviderId === id) st.ai.triageProviderId = null;
    });
  }

  // Debounced save for free-text fields.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (app.settings) app.saveSettings($state.snapshot(app.settings) as typeof app.settings).catch(() => {});
    }, 500);
  }

  function setUi<K extends keyof NonNullable<typeof s>["ui"]>(key: K, value: NonNullable<typeof s>["ui"][K]) {
    app.patchSettings((st) => {
      st.ui[key] = value;
    });
    if (key === "density") document.documentElement.dataset.density = value as string;
  }

  const HUES = [-1, 28, 95, 150, 190, 220, 265, 310, 345];
</script>

{#if app.settingsOpen && s}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => (app.settingsOpen = false)}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <nav>
        <div class="nav-title">Settings</div>
        {#each SECTIONS as sec}
          <button class:active={app.settingsSection === sec.id} onclick={() => (app.settingsSection = sec.id)}>
            <sec.icon size={15} />
            {sec.label}
          </button>
        {/each}
      </nav>

      <div class="content">
        <button class="close icon-btn" onclick={() => (app.settingsOpen = false)} aria-label="Close"><X size={16} /></button>

        {#if app.settingsSection === "accounts"}
          <h2>Accounts</h2>
          <div class="list">
            {#each app.accounts as a (a.id)}
              {@const raw = app.syncStatus[a.id]?.state ?? a.status}
              {@const st = raw === "idle" ? "ok" : raw}
              <div class="acct">
                <span class="dot" style:background={hueColor(a.hue, app.mode)}></span>
                <div class="info">
                  {#if renaming === a.id}
                    <form
                      onsubmit={(e) => {
                        e.preventDefault();
                        app.updateAccount(a.id, { displayName: renameText.trim() });
                        renaming = null;
                      }}>
                      <input class="field" bind:value={renameText} placeholder="Display name" />
                    </form>
                  {:else}
                    <div class="an">{a.displayName || a.email}</div>
                  {/if}
                  <div class="ae">{a.email} · <span class="st {st}">{st === "ok" ? `synced ${relative(app.syncStatus[a.id]?.lastSync ?? a.lastSync)}` : st}</span></div>
                  <div class="hues">
                    {#each HUES as h}
                      <button
                        class="hue"
                        class:on={a.hue === h}
                        style:background={hueColor(h, app.mode)}
                        aria-label="Color"
                        onclick={() => app.updateAccount(a.id, { hue: h })}></button>
                    {/each}
                  </div>
                </div>
                {#if st === "reauth"}
                  <button class="btn sm primary" onclick={addAccount}>Sign in again</button>
                {/if}
                <button class="icon-btn" title="Rename" onclick={() => { renaming = a.id; renameText = a.displayName; }}><Pencil size={14} /></button>
                {#if confirmRemove === a.id}
                  <button class="btn sm danger" onclick={() => { app.removeAccount(a.id); confirmRemove = null; }}>Remove?</button>
                {:else}
                  <button class="icon-btn" title="Remove account" onclick={() => (confirmRemove = a.id)}><Trash2 size={14} /></button>
                {/if}
              </div>
            {/each}
          </div>

          <button class="btn lg add" onclick={addAccount} disabled={adding}>
            {#if adding}<LoaderCircle size={15} class="spin" /> Waiting for browser…{:else}<Plus size={15} /> Add Microsoft 365 / Outlook account{/if}
          </button>
          {#if adding}
            <button class="btn ghost sm" onclick={() => api.cancelAuth()}>Cancel</button>
          {/if}

          <h3>Microsoft app registration</h3>
          <div class="grid2">
            <label>
              <span class="label">Client ID</span>
              <input class="field mono" bind:value={s.microsoft.clientId} oninput={saveSoon} placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" />
            </label>
            <label>
              <span class="label">Tenant</span>
              <input class="field mono" bind:value={s.microsoft.tenant} oninput={saveSoon} placeholder="common" spellcheck="false" />
            </label>
          </div>
          <p class="hint">Use <code>common</code> to allow work, school and personal Outlook.com accounts.</p>
        {:else if app.settingsSection === "ai"}
          <h2>AI</h2>
          <p class="lead">Tern works with Anthropic Claude or any OpenAI-compatible API — cloud or local.</p>

          <div class="list">
            {#each s.ai.providers as p (p.id)}
              {#if editing === p.id}
                <div class="card"><ProviderEditor provider={p} onsave={saveProvider} oncancel={() => (editing = null)} /></div>
              {:else}
                <div class="prov">
                  <div class="pi">
                    <div class="an">
                      {p.name}
                      {#if s.ai.defaultProviderId === p.id}<span class="chip def">Default</span>{/if}
                      {#if s.ai.triageProviderId === p.id}<span class="chip tri">Triage</span>{/if}
                    </div>
                    <div class="ae mono">{p.model}{p.baseUrl ? ` · ${p.baseUrl}` : ""}{p.hasKey ? "" : p.kind === "anthropic" ? " · no key" : ""}</div>
                  </div>
                  {#if s.ai.defaultProviderId !== p.id}
                    <button class="btn sm ghost" onclick={() => app.patchSettings((st) => (st.ai.defaultProviderId = p.id))}>Make default</button>
                  {/if}
                  <button class="icon-btn" title="Edit" onclick={() => (editing = p.id)}><Pencil size={14} /></button>
                  <button class="icon-btn" title="Remove" onclick={() => removeProvider(p.id)}><Trash2 size={14} /></button>
                </div>
              {/if}
            {/each}
          </div>

          {#if editing === "new"}
            <div class="card">
              <ProviderEditor provider={null} onsave={async (p) => { await saveProvider(p); }} oncancel={() => (editing = null)} />
            </div>
          {:else}
            <button class="btn add" onclick={() => (editing = "new")}><Plus size={14} /> Add provider</button>
          {/if}

          {#if s.ai.providers.length}
            <h3>Behavior</h3>
            <div class="grid2">
              <label>
                <span class="label">Triage provider</span>
                <select class="field" value={s.ai.triageProviderId ?? ""} onchange={(e) => app.patchSettings((st) => (st.ai.triageProviderId = (e.currentTarget as HTMLSelectElement).value || null))}>
                  <option value="">Same as default</option>
                  {#each s.ai.providers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
                </select>
              </label>
            </div>
            <label class="toggle">
              <input type="checkbox" checked={s.ai.triageEnabled} onchange={(e) => app.patchSettings((st) => (st.ai.triageEnabled = (e.currentTarget as HTMLInputElement).checked)).then(() => app.scheduleTriage(200))} />
              <span><b>Smart inbox</b> — sort new mail into Needs reply, FYI, Newsletters… with a one-line summary.</span>
            </label>
            <label class="toggle">
              <input type="checkbox" checked={s.ai.autoApproveSafeActions} onchange={(e) => app.patchSettings((st) => (st.ai.autoApproveSafeActions = (e.currentTarget as HTMLInputElement).checked))} />
              <span><b>Let the agent archive, flag and mark read without asking.</b> Sending and deleting always need your approval.</span>
            </label>
            <label class="block">
              <span class="label">About me</span>
              <textarea class="field" rows="4" bind:value={s.ai.aboutMe} oninput={saveSoon} placeholder="e.g. I'm a partner at Emcap. Keep replies short and direct. Write in Swedish to Swedes, English otherwise. My assistant is Anna."></textarea>
              <span class="hint">Helps Tern prioritise and write like you.</span>
            </label>
          {/if}
        {:else if app.settingsSection === "appearance"}
          <h2>Appearance</h2>
          <p class="lead">Colors follow your Omarchy theme{app.theme ? ` (${app.theme.name})` : ""} and update live when you switch.</p>
          <div class="opt-row">
            <div><b>Density</b><span class="hint">How much fits in the message list</span></div>
            <div class="seg">
              <button class:on={s.ui.density === "comfortable"} onclick={() => setUi("density", "comfortable")}>Comfortable</button>
              <button class:on={s.ui.density === "compact"} onclick={() => setUi("density", "compact")}>Compact</button>
            </div>
          </div>
          <div class="opt-row">
            <div><b>Email rendering</b><span class="hint">Paper keeps designed mail as intended; adaptive blends simple mail into the theme</span></div>
            <div class="seg">
              <button class:on={s.ui.mailRendering === "paper"} onclick={() => setUi("mailRendering", "paper")}>Paper</button>
              <button class:on={s.ui.mailRendering === "adaptive"} onclick={() => setUi("mailRendering", "adaptive")}>Adaptive</button>
            </div>
          </div>
          <div class="opt-row">
            <div><b>Remote images</b><span class="hint">Remote images can track when you open mail</span></div>
            <div class="seg">
              <button class:on={s.ui.remoteImages === "never"} onclick={() => setUi("remoteImages", "never")}>Never</button>
              <button class:on={s.ui.remoteImages === "ask"} onclick={() => setUi("remoteImages", "ask")}>Ask</button>
              <button class:on={s.ui.remoteImages === "always"} onclick={() => setUi("remoteImages", "always")}>Always</button>
            </div>
          </div>
          <div class="opt-row">
            <div><b>Translucent window</b><span class="hint">Let Hyprland blur show through</span></div>
            <div class="seg">
              <button class:on={!s.ui.translucent} onclick={() => setUi("translucent", false)}>Off</button>
              <button class:on={s.ui.translucent} onclick={() => setUi("translucent", true)}>On</button>
            </div>
          </div>
        {:else if app.settingsSection === "signatures"}
          <h2>Signatures</h2>
          <p class="lead">Appended to new messages and replies. HTML allowed.</p>
          {#each app.accounts as a (a.id)}
            <label class="block">
              <span class="label"><span class="dot inline" style:background={hueColor(a.hue, app.mode)}></span> {a.email}</span>
              <textarea
                class="field mono"
                rows="4"
                value={s.signatures[a.id] ?? ""}
                oninput={(e) => {
                  s.signatures[a.id] = (e.currentTarget as HTMLTextAreaElement).value;
                  saveSoon();
                }}
                placeholder="—<br>Your Name<br>Title, Company"></textarea>
            </label>
          {:else}
            <p class="hint">Add an account first.</p>
          {/each}
        {:else if app.settingsSection === "sync"}
          <h2>Sync</h2>
          <div class="opt-row">
            <div><b>Check for new mail every</b><span class="hint">Uses Microsoft Graph delta queries — cheap and fast</span></div>
            <div class="seg">
              {#each [30, 60, 120, 300] as n}
                <button class:on={s.syncIntervalSecs === n} onclick={() => app.patchSettings((st) => (st.syncIntervalSecs = n))}>
                  {n < 60 ? `${n}s` : `${n / 60}m`}
                </button>
              {/each}
            </div>
          </div>
          <button class="btn" onclick={() => app.syncNow()}><RefreshCw size={14} /> Sync now</button>
          {#if app.accounts.length}
            <div class="list status">
              {#each app.accounts as a (a.id)}
                {@const ss = app.syncStatus[a.id]}
                <div class="srow">
                  <span class="dot" style:background={hueColor(a.hue, app.mode)}></span>
                  <span class="se">{a.email}</span>
                  <span class="hint">{ss?.state ?? a.status} · {relative(ss?.lastSync ?? a.lastSync)}</span>
                  {#if ["ok", "idle"].includes(ss?.state ?? a.status)}<Check size={13} class="okc" />{/if}
                </div>
                {#if ss?.message}<div class="hint err">{ss.message}</div>{/if}
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--bg-darker) 55%, transparent);
    animation: fade 140ms;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .modal {
    display: grid;
    grid-template-columns: 200px 1fr;
    width: min(880px, calc(100vw - 40px));
    height: min(680px, calc(100vh - 60px));
    border-radius: 18px;
    overflow: hidden;
    background: color-mix(in oklab, var(--bg-lighter) 40%, var(--bg));
    box-shadow: var(--shadow);
    animation: fade-up 200ms var(--ease);
  }
  nav {
    padding: 18px 10px;
    background: color-mix(in oklab, var(--bg-darker) 40%, transparent);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav-title {
    padding: 0 12px 12px;
    font-weight: 680;
    font-size: 14px;
  }
  nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 12px;
    border-radius: 8px;
    color: var(--fg-dim);
    font-size: 13px;
  }
  nav button:hover {
    background: var(--hover);
    color: var(--fg);
  }
  nav button.active {
    background: var(--active);
    color: var(--fg-bright);
  }
  nav button.active :global(svg) {
    color: var(--accent);
  }
  .content {
    position: relative;
    overflow-y: auto;
    padding: 26px 32px 40px;
    user-select: text;
  }
  .close {
    position: absolute;
    top: 14px;
    right: 14px;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: 680;
    letter-spacing: -0.02em;
  }
  h3 {
    margin: 28px 0 12px;
    font-size: 13px;
    font-weight: 650;
    color: var(--fg-bright);
  }
  .lead {
    margin: 0 0 18px;
    color: var(--fg-dim);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 16px 0;
  }
  .acct,
  .prov {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 12px 12px 16px;
    border-radius: 12px;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }
  .dot.inline {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 4px;
  }
  .info,
  .pi {
    flex: 1;
    min-width: 0;
  }
  .an {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 620;
  }
  .ae {
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st.error,
  .st.reauth {
    color: var(--red);
  }
  .hues {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .hue {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    opacity: 0.7;
    transition: transform var(--t);
  }
  .hue:hover {
    transform: scale(1.15);
    opacity: 1;
  }
  .hue.on {
    opacity: 1;
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 3.5px var(--fg-dim);
  }
  .add {
    margin-right: 8px;
  }
  .chip.def {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .chip.tri {
    color: var(--cyan);
    background: color-mix(in oklab, var(--cyan) 14%, transparent);
  }
  .card {
    padding: 18px;
    border-radius: 14px;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--accent-line);
    margin-bottom: 12px;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .toggle {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 14px 0;
    font-size: 13px;
    color: var(--fg-dim);
    cursor: pointer;
  }
  .toggle b {
    color: var(--fg);
    font-weight: 600;
  }
  .toggle input {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .block {
    display: block;
    margin: 16px 0;
  }
  select.field option {
    background: var(--bg);
  }
  .opt-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 0;
    border-bottom: 1px solid var(--line);
  }
  .opt-row b {
    display: block;
    font-weight: 600;
  }
  .opt-row .hint {
    display: block;
  }
  .seg {
    display: inline-flex;
    flex: none;
    padding: 3px;
    border-radius: 9px;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .seg button {
    height: 28px;
    padding: 0 12px;
    border-radius: 7px;
    font-size: 12.5px;
    color: var(--fg-dim);
  }
  .seg button.on {
    background: var(--raised);
    color: var(--fg-bright);
    box-shadow: var(--shadow-sm);
  }
  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--hover);
  }
  .status {
    margin-top: 20px;
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .srow .se {
    flex: 1;
  }
  .srow :global(.okc) {
    color: var(--green);
  }
  .err {
    color: var(--red);
  }
</style>
