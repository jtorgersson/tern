<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { api } from "$lib/api";
  import type { AiProvider } from "$lib/types";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import ProviderEditor from "./ProviderEditor.svelte";
  import Logo from "./Logo.svelte";
  import { ArrowRight, LoaderCircle, Check, ChevronDown, ExternalLink, Sparkles, Copy } from "@lucide/svelte";

  let step = $state<"welcome" | "microsoft" | "ai" | "done">(app.accounts.length ? "ai" : "welcome");
  let clientId = $state(app.settings?.microsoft.clientId ?? "");
  let tenant = $state(app.settings?.microsoft.tenant || "common");
  let showHelp = $state(!app.settings?.microsoft.clientId);
  let signingIn = $state(false);
  let aiSaved = $state(false);

  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validId = $derived(GUID.test(clientId.trim()));

  const PERMS = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "MailboxSettings.Read"];

  async function signIn() {
    if (!validId) return;
    signingIn = true;
    await app.patchSettings((s) => {
      s.microsoft.clientId = clientId.trim();
      s.microsoft.tenant = tenant.trim() || "common";
    });
    const acct = await app.addMicrosoftAccount();
    signingIn = false;
    if (acct) step = "ai";
  }

  async function saveProvider(p: AiProvider) {
    await app.patchSettings((s) => {
      s.ai.providers = [...s.ai.providers.filter((x) => x.id !== p.id), p];
      s.ai.defaultProviderId = p.id;
      s.ai.triageEnabled = true;
    });
    aiSaved = true;
  }

  $effect(() => {
    app.onboarding = true;
  });

  function finish() {
    app.scheduleTriage(500);
    step = "done";
    app.onboarding = false;
  }

  const progressLabel = $derived.by(() => {
    switch (app.authProgress?.state) {
      case "waiting_browser":
        return "Finish signing in in your browser…";
      case "exchanging":
        return "Securing your session…";
      case "done":
        return "Signed in";
      case "error":
        return app.authProgress.message ?? "Sign-in failed";
      default:
        return "";
    }
  });
</script>

<div class="onb" data-tauri-drag-region>
  <div class="glow" aria-hidden="true"></div>

  {#if step === "welcome"}
    <div class="card hero">
      <div class="logo"><Logo size={56} /></div>
      <h1>Tern</h1>
      <p class="tag">Mail that sorts, summarizes and drafts itself — and stays out of your way.</p>
      <ul class="feats">
        <li><Sparkles size={14} /> Smart inbox: needs-reply, FYI, newsletters, receipts</li>
        <li><Sparkles size={14} /> Ask in plain language: “archive everything from LinkedIn”</li>
        <li><Sparkles size={14} /> Replies drafted in your voice, sent only when you say so</li>
      </ul>
      <button class="btn primary lg" onclick={() => (step = "microsoft")}>Get started <ArrowRight size={15} /></button>
      <div class="foot hint">Keyboard-first · follows your Omarchy theme · press <kbd>?</kbd> anytime</div>
    </div>
  {:else if step === "microsoft"}
    <div class="card">
      <div class="stepper"><span class="on">1</span><i></i><span>2</span></div>
      <h2>Connect Microsoft 365</h2>
      <p class="lead">Tern talks to Outlook through Microsoft Graph using your own app registration — your mail never touches a third-party server.</p>

      <div class="grid">
        <label>
          <span class="label">Application (client) ID</span>
          <input class="field mono" bind:value={clientId} placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" />
        </label>
        <label>
          <span class="label">Tenant</span>
          <input class="field mono" bind:value={tenant} placeholder="common" spellcheck="false" />
        </label>
      </div>

      <button class="help-toggle" onclick={() => (showHelp = !showHelp)}>
        <span class="chev" class:open={showHelp}><ChevronDown size={13} /></span> How do I get a client ID? (2 minutes)
      </button>
      {#if showHelp}
        <ol class="help">
          <li>
            Open <button class="link" onclick={() => openUrl("https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade")}>Entra admin center → App registrations <ExternalLink size={11} /></button> and choose <b>New registration</b>.
          </li>
          <li>Name it <b>Tern</b>. Supported account types: <b>Accounts in any organizational directory and personal Microsoft accounts</b> (or your org only).</li>
          <li>Redirect URI: platform <b>Public client/native (mobile &amp; desktop)</b>, value <code>http://localhost</code>.</li>
          <li><b>Authentication</b> → Advanced settings → <b>Allow public client flows: Yes</b>.</li>
          <li>
            <b>API permissions</b> → Microsoft Graph → Delegated:
            <span class="perms">{#each PERMS as p}<code>{p}</code>{/each}</span>
            <button class="link small" onclick={() => navigator.clipboard.writeText(PERMS.join(" "))}><Copy size={11} /> copy</button>
          </li>
          <li>Copy the <b>Application (client) ID</b> from Overview and paste it above.</li>
        </ol>
      {/if}

      <div class="actions">
        <button class="btn primary lg" disabled={!validId || signingIn} onclick={signIn}>
          {#if signingIn}<LoaderCircle size={15} class="spin" />{:else}<svg width="15" height="15" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" /><rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" /></svg>{/if}
          Sign in with Microsoft
        </button>
        {#if signingIn}
          <button class="btn ghost" onclick={() => api.cancelAuth()}>Cancel</button>
        {:else}
          <button class="btn ghost" onclick={() => (step = "welcome")}>Back</button>
        {/if}
      </div>
      {#if progressLabel && (signingIn || app.authProgress?.state === "error")}
        <div class="progress" class:err={app.authProgress?.state === "error"}>
          {#if app.authProgress?.state !== "error"}<LoaderCircle size={13} class="spin" />{/if}
          {progressLabel}
        </div>
      {/if}
    </div>
  {:else if step === "ai"}
    <div class="card">
      <div class="stepper"><span class="done"><Check size={12} /></span><i class="on"></i><span class="on">2</span></div>
      <h2>Add an AI model</h2>
      <p class="lead">Powers the smart inbox, summaries, drafting and the agent. Claude is recommended; any OpenAI-compatible endpoint works, including local Ollama.</p>
      <ProviderEditor provider={app.settings?.ai.providers[0] ?? null} onsave={saveProvider} />
      <div class="actions">
        <button class="btn primary lg" onclick={finish} disabled={!aiSaved}>Open inbox <ArrowRight size={15} /></button>
        <button class="btn ghost" onclick={finish}>Skip for now</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .onb {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    overflow-y: auto;
    padding: 40px 20px;
    background: var(--surface);
  }
  .glow {
    position: absolute;
    inset: -20%;
    pointer-events: none;
    background:
      radial-gradient(40% 35% at 25% 20%, color-mix(in oklab, var(--accent) 16%, transparent), transparent),
      radial-gradient(35% 30% at 80% 85%, color-mix(in oklab, var(--blue) 12%, transparent), transparent);
    filter: blur(20px);
  }
  .card {
    position: relative;
    width: min(640px, 100%);
    padding: 36px 40px;
    border-radius: 22px;
    background: color-mix(in oklab, var(--bg-lighter) 45%, var(--bg));
    box-shadow: var(--shadow);
    animation: fade-up 280ms var(--ease);
    user-select: text;
  }
  .hero {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 48px 44px 36px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 92px;
    height: 92px;
    border-radius: 28px;
    background: radial-gradient(circle at 30% 25%, var(--accent-soft), transparent 75%);
    box-shadow:
      inset 0 0 0 1px var(--line),
      0 20px 60px -20px rgba(var(--accent-rgb), 0.5);
  }
  h1 {
    margin: 18px 0 6px;
    font-size: 40px;
    font-weight: 720;
    letter-spacing: -0.04em;
    color: var(--fg-bright);
  }
  .tag {
    margin: 0 0 22px;
    font-size: 15px;
    color: var(--fg-dim);
    max-width: 420px;
    line-height: 1.5;
  }
  .feats {
    list-style: none;
    padding: 0;
    margin: 0 0 28px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    text-align: left;
    font-size: 13px;
    color: var(--fg-dim);
  }
  .feats li {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .feats :global(svg) {
    color: var(--accent);
    flex: none;
  }
  .foot {
    margin-top: 26px;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 20px;
  }
  .stepper span {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    box-shadow: inset 0 0 0 1.5px var(--line-strong);
  }
  .stepper span.on {
    color: var(--on-accent);
    background: var(--accent);
    box-shadow: none;
  }
  .stepper span.done {
    color: var(--accent);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .stepper i {
    width: 40px;
    height: 2px;
    border-radius: 2px;
    background: var(--line-strong);
  }
  .stepper i.on {
    background: var(--accent);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--fg-bright);
  }
  .lead {
    margin: 0 0 22px;
    color: var(--fg-dim);
    line-height: 1.55;
  }
  .grid {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 12px;
  }
  .help-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 16px;
    font-size: 12.5px;
    color: var(--accent);
  }
  .chev {
    display: grid;
    transition: transform var(--t);
    transform: rotate(-90deg);
  }
  .chev.open {
    transform: none;
  }
  .help {
    margin: 12px 0 0;
    padding: 14px 18px 14px 34px;
    border-radius: 12px;
    background: color-mix(in oklab, var(--bg-darker) 45%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--fg-dim);
  }
  .help li {
    margin: 4px 0;
  }
  .help b {
    color: var(--fg);
    font-weight: 600;
  }
  code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--hover);
    color: var(--fg);
  }
  .perms {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0 4px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent);
    font-weight: 550;
  }
  .link.small {
    font-size: 11.5px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 26px;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    font-size: 12.5px;
    color: var(--fg-dim);
  }
  .progress.err {
    color: var(--red);
  }
</style>
