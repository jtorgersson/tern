<script lang="ts">
  import { api } from "$lib/api";
  import { testProvider } from "$lib/ai";
  import type { AiProvider, AiProviderKind } from "$lib/types";
  import { errMsg } from "$lib/util/misc";
  import { LoaderCircle, CircleCheck, CircleAlert } from "@lucide/svelte";

  let {
    provider,
    onsave,
    oncancel,
    compact = false,
  }: {
    provider: AiProvider | null;
    onsave: (p: AiProvider) => Promise<void> | void;
    oncancel?: () => void;
    compact?: boolean;
  } = $props();

  const PRESETS: { name: string; baseUrl: string; model: string; needsKey: boolean }[] = [
    { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "", needsKey: true },
    { name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "", needsKey: false },
    { name: "LM Studio", baseUrl: "http://localhost:1234/v1", model: "", needsKey: false },
    { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "", needsKey: true },
    { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "", needsKey: true },
  ];

  // svelte-ignore state_referenced_locally
  const initial = provider;
  let kind = $state<AiProviderKind>(initial?.kind ?? "anthropic");
  let name = $state(initial?.name ?? "Claude");
  let baseUrl = $state(initial?.baseUrl ?? "");
  let model = $state(initial?.model ?? "claude-opus-5-5");
  let fastModel = $state(initial?.fastModel ?? "");
  let key = $state("");
  const id = initial?.id ?? `p-${Math.random().toString(36).slice(2, 9)}`;

  let status = $state<{ state: "idle" | "testing" | "ok" | "error"; msg?: string }>({ state: "idle" });

  function setKind(k: AiProviderKind) {
    if (k === kind) return;
    kind = k;
    if (k === "anthropic") {
      name = "Claude";
      baseUrl = "";
      model = "claude-opus-5-5";
    } else {
      name = "OpenAI";
      baseUrl = PRESETS[0].baseUrl;
      model = "";
    }
    fastModel = "";
  }

  function preset(p: (typeof PRESETS)[number]) {
    name = p.name;
    baseUrl = p.baseUrl;
    if (p.model) model = p.model;
  }

  function build(hasKey: boolean): AiProvider {
    return {
      id,
      kind,
      name: name.trim() || (kind === "anthropic" ? "Claude" : "OpenAI-compatible"),
      baseUrl: baseUrl.trim() || null,
      model: model.trim(),
      fastModel: fastModel.trim() || null,
      hasKey,
    };
  }

  async function saveAndTest() {
    if (!model.trim()) {
      status = { state: "error", msg: "Model is required" };
      return;
    }
    if (kind === "openai" && !baseUrl.trim()) {
      status = { state: "error", msg: "Base URL is required" };
      return;
    }
    status = { state: "testing" };
    try {
      if (key.trim()) await api.secretSet(`ai:${id}`, key.trim());
      const p = build(!!key.trim() || !!initial?.hasKey);
      await onsave(p);
      await testProvider(p);
      status = { state: "ok", msg: "Connected" };
      key = "";
    } catch (e) {
      status = { state: "error", msg: errMsg(e) };
    }
  }
</script>

<div class="pe" class:compact>
  <div class="seg">
    <button class:on={kind === "anthropic"} onclick={() => setKind("anthropic")}>Anthropic Claude</button>
    <button class:on={kind === "openai"} onclick={() => setKind("openai")}>OpenAI-compatible</button>
  </div>

  {#if kind === "openai"}
    <div class="presets">
      {#each PRESETS as p}
        <button class="preset" class:on={baseUrl === p.baseUrl} onclick={() => preset(p)}>{p.name}</button>
      {/each}
    </div>
  {/if}

  <div class="grid">
    <label>
      <span class="label">Name</span>
      <input class="field" bind:value={name} />
    </label>
    {#if kind === "openai"}
      <label>
        <span class="label">Base URL</span>
        <input class="field mono" bind:value={baseUrl} placeholder="https://…/v1" spellcheck="false" />
      </label>
    {/if}
    <label>
      <span class="label">Model</span>
      <input class="field mono" bind:value={model} placeholder={kind === "anthropic" ? "claude-opus-5-5" : "e.g. gpt-5.1, llama3.3, qwen3"} spellcheck="false" />
    </label>
    <label>
      <span class="label">Triage model <span class="opt">(optional, for bulk sorting)</span></span>
      <input class="field mono" bind:value={fastModel} placeholder="same as model" spellcheck="false" />
    </label>
    <label class="wide">
      <span class="label">API key {#if kind === "openai"}<span class="opt">(local servers usually need none)</span>{/if}</span>
      <input
        class="field mono"
        type="password"
        bind:value={key}
        placeholder={initial?.hasKey ? "•••••••••••• stored in keyring — type to replace" : kind === "anthropic" ? "sk-ant-…" : "sk-…"}
        autocomplete="off" />
    </label>
  </div>

  <div class="foot">
    <button class="btn primary" onclick={saveAndTest} disabled={status.state === "testing"}>
      {#if status.state === "testing"}<LoaderCircle size={14} class="spin" />{/if}
      Save & test
    </button>
    {#if oncancel}<button class="btn ghost" onclick={oncancel}>Cancel</button>{/if}
    {#if status.state === "ok"}
      <span class="st ok"><CircleCheck size={14} /> {status.msg}</span>
    {:else if status.state === "error"}
      <span class="st err"><CircleAlert size={14} /> {status.msg}</span>
    {/if}
  </div>
  <p class="hint">Keys are stored in your system keyring (gnome-keyring), never in config files.</p>
</div>

<style>
  .pe {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .seg {
    display: inline-flex;
    align-self: flex-start;
    padding: 3px;
    border-radius: 9px;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .seg button {
    height: 28px;
    padding: 0 14px;
    border-radius: 7px;
    font-size: 12.5px;
    font-weight: 550;
    color: var(--fg-dim);
  }
  .seg button.on {
    background: var(--raised);
    color: var(--fg-bright);
    box-shadow: var(--shadow-sm);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .preset {
    height: 26px;
    padding: 0 11px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--fg-dim);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }
  .preset.on {
    color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 14px;
  }
  .compact .grid {
    grid-template-columns: 1fr;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .opt {
    font-weight: 400;
    color: var(--muted);
    letter-spacing: 0;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .st {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    user-select: text;
  }
  .st.ok {
    color: var(--green);
  }
  .st.err {
    color: var(--red);
  }
  .hint {
    margin: 0;
  }
</style>
