<script lang="ts">
  import { tick } from "svelte";
  import { Smile, X } from "@lucide/svelte";
  import { EMOJIS } from "$lib/util/emoji";

  let { onSelect, onOpen = () => {}, disabled = false }: {
    onSelect: (emoji: string) => void; onOpen?: () => void; disabled?: boolean;
  } = $props();
  const id = $props.id();
  let trigger: HTMLButtonElement;
  let panel: HTMLDivElement;
  let input: HTMLInputElement;
  let open = $state(false);
  let query = $state("");
  let left = $state(0);
  let top = $state(0);
  const matches = $derived(EMOJIS.filter(([emoji, keywords]) => `${emoji} ${keywords}`.includes(query.toLowerCase().trim())));

  function position() {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 16);
    const height = Math.min(310, window.innerHeight - 16);
    left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(rect.top - height - 8, window.innerHeight - height - 8));
  }
  async function toggle() {
    if (open) { panel.hidePopover(); return; }
    onOpen();
    query = "";
    position();
    panel.showPopover();
    await tick();
    input.focus();
  }
  function choose(emoji: string) {
    panel.hidePopover();
    onSelect(emoji);
  }
  function keydown(e: KeyboardEvent) {
    // Keep picker navigation out of mail shortcuts and Ctrl+Enter send handlers.
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); panel.hidePopover(); trigger.focus(); }
    if (e.key === "Enter" && e.target === input && matches[0]) { e.preventDefault(); choose(matches[0][0]); }
    if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key) && e.target !== input) {
      const buttons = [...panel.querySelectorAll<HTMLButtonElement>(".emoji")];
      const index = buttons.indexOf(e.target as HTMLButtonElement);
      if (index < 0) return;
      e.preventDefault();
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 }[e.key]!;
      buttons[Math.max(0, Math.min(buttons.length - 1, index + step))]?.focus();
    }
  }
</script>

<svelte:window onresize={() => { if (open) position(); }} />
<button bind:this={trigger} type="button" class="icon-btn" title="Insert emoji" aria-label="Insert emoji" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" {disabled} onclick={toggle}><Smile size={16} /></button>
<!-- Popovers render in the top layer, including inside scrollable composers. -->
<div bind:this={panel} {id} class="picker" popover="auto" role="dialog" aria-label="Choose an emoji" tabindex="-1" style:left={`${left}px`} style:top={`${top}px`} ontoggle={(e) => open = e.newState === "open"} onkeydown={keydown}>
  <div class="head"><strong>Emoji</strong><button type="button" class="icon-btn" aria-label="Close emoji picker" onclick={() => { panel.hidePopover(); trigger.focus(); }}><X size={14} /></button></div>
  <input bind:this={input} aria-label="Search emoji" placeholder="Search emoji…" bind:value={query} />
  <div class="grid">
    {#each matches as [emoji, keywords]}
      <button type="button" class="emoji" aria-label={keywords} title={keywords} onclick={() => choose(emoji)}>{emoji}</button>
    {:else}<p>No matching emoji.</p>{/each}
  </div>
</div>

<style>
  .picker { position: fixed; inset: auto; margin: 0; box-sizing: border-box; width: min(288px, calc(100vw - 16px)); height: min(310px, calc(100vh - 16px)); padding: 12px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); color: var(--fg); box-shadow: 0 12px 40px #0004; }
  .picker:popover-open { display: flex; flex-direction: column; }
  .head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; margin-bottom: 8px; }
  input { width: 100%; box-sizing: border-box; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px; font-size: 12px; color: var(--fg); }
  input:focus { outline: 1px solid var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(8, 1fr); align-content: start; overflow-y: auto; margin-top: 8px; min-height: 0; gap: 2px; }
  .emoji { display: grid; place-items: center; min-height: 30px; border-radius: 6px; font-size: 20px; }
  .emoji:hover, .emoji:focus-visible { background: var(--accent-soft); outline: 1px solid var(--accent-line); }
  p { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
</style>
