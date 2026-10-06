<script lang="ts">
  import { api } from "$lib/api";
  import type { Addr, Contact } from "$lib/types";
  import { displayName, isValidEmail, parseAddrList } from "$lib/util/misc";
  import { X } from "@lucide/svelte";

  let { label, value = $bindable([]), autofocus = false }: { label: string; value: Addr[]; autofocus?: boolean } = $props();

  let text = $state("");
  let suggestions = $state<Contact[]>([]);
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (autofocus) input?.focus();
  });

  function lookup() {
    clearTimeout(timer);
    const q = text.trim();
    if (q.length < 1) {
      suggestions = [];
      return;
    }
    timer = setTimeout(async () => {
      try {
        const have = new Set(value.map((a) => a.email.toLowerCase()));
        suggestions = (await api.contacts(q, 7)).filter((c) => !have.has(c.email.toLowerCase()));
        active = 0;
      } catch {
        suggestions = [];
      }
    }, 90);
  }

  function add(a: Addr) {
    if (!value.some((v) => v.email.toLowerCase() === a.email.toLowerCase())) value = [...value, a];
    text = "";
    suggestions = [];
  }

  function commitText(): boolean {
    const parsed = parseAddrList(text).filter((a) => isValidEmail(a.email));
    if (!parsed.length) return false;
    parsed.forEach(add);
    return true;
  }

  function onkeydown(e: KeyboardEvent) {
    if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
    } else if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
      if (suggestions.length && text.trim()) {
        e.preventDefault();
        const s = suggestions[active];
        add({ name: s.name, email: s.email });
      } else if (text.trim()) {
        if (commitText()) e.preventDefault();
      }
    } else if (e.key === "Backspace" && !text && value.length) {
      value = value.slice(0, -1);
    } else if (e.key === "Escape" && suggestions.length) {
      e.stopPropagation();
      suggestions = [];
    }
  }

  function onpaste(e: ClipboardEvent) {
    const t = e.clipboardData?.getData("text") ?? "";
    if (/[,;]/.test(t)) {
      e.preventDefault();
      text = t;
      commitText();
    }
  }
</script>

<div class="addr">
  <span class="lbl">{label}</span>
  <div class="chips">
    {#each value as a, i (a.email + i)}
      <span class="chip-a" class:bad={!isValidEmail(a.email)} title={a.email}>
        {displayName(a)}
        <button aria-label="Remove {a.email}" onclick={() => (value = value.filter((_, j) => j !== i))}><X size={11} /></button>
      </span>
    {/each}
    <input
      bind:this={input}
      bind:value={text}
      oninput={lookup}
      {onkeydown}
      {onpaste}
      onblur={() => setTimeout(() => { commitText(); suggestions = []; }, 120)}
      spellcheck="false" />
  </div>
  {#if suggestions.length}
    <div class="sugg">
      {#each suggestions as s, i (s.email)}
        <button class:active={i === active} onmousedown={(e) => { e.preventDefault(); add({ name: s.name, email: s.email }); }}>
          <span class="sn">{s.name || s.email}</span>
          {#if s.name}<span class="se">{s.email}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .addr {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--line);
  }
  .lbl {
    width: 34px;
    padding-top: 5px;
    font-size: 12px;
    color: var(--muted);
    flex: none;
  }
  .chips {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    min-height: 28px;
  }
  .chip-a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 4px 0 10px;
    border-radius: 999px;
    font-size: 12.5px;
    background: var(--accent-soft);
    color: var(--fg-bright);
  }
  .chip-a.bad {
    background: color-mix(in oklab, var(--red) 18%, transparent);
  }
  .chip-a button {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: var(--fg-dim);
  }
  .chip-a button:hover {
    background: var(--hover);
    color: var(--fg);
  }
  input {
    flex: 1;
    min-width: 120px;
    height: 26px;
    border: 0;
    outline: 0;
    background: none;
    font-size: 13px;
  }
  .sugg {
    position: absolute;
    left: 44px;
    top: calc(100% + 4px);
    z-index: 5;
    min-width: 300px;
    padding: 4px;
    border-radius: var(--r);
    background: var(--raised);
    box-shadow: var(--shadow);
  }
  .sugg button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    padding: 6px 10px;
    border-radius: 6px;
    text-align: left;
  }
  .sugg button.active {
    background: var(--active);
  }
  .sn {
    font-size: 13px;
  }
  .se {
    font-size: 11.5px;
    color: var(--muted);
  }
</style>
