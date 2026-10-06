<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { renderMail } from "$lib/util/html";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { ImageOff } from "@lucide/svelte";

  let { html }: { html: string } = $props();

  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(120);
  let allowOnce = $state(false);

  const policy = $derived(app.settings?.ui.remoteImages ?? "ask");
  const allowRemote = $derived(policy === "always" || allowOnce);

  const rendered = $derived.by(() => {
    void app.theme; // re-render on theme change
    const cs = getComputedStyle(document.documentElement);
    return renderMail(html, {
      allowRemote,
      mode: app.settings?.ui.mailRendering ?? "adaptive",
      fg: cs.getPropertyValue("--fg").trim() || "#ddd",
      link: cs.getPropertyValue("--accent").trim() || "#7aa2f7",
      font: `"Adwaita Sans", "Inter", system-ui, sans-serif`,
    });
  });

  let ro: ResizeObserver | null = null;

  function onload() {
    const doc = frame?.contentDocument;
    if (!doc) return;
    const measure = () => {
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      if (h && Math.abs(h - height) > 2) height = h;
    };
    measure();
    ro?.disconnect();
    ro = new ResizeObserver(measure);
    ro.observe(doc.documentElement);
    doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure, { once: true }));
    doc.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest?.("a");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (/^(https?|mailto|tel):/i.test(href)) openUrl(href).catch(() => {});
    });
  }

  $effect(() => () => ro?.disconnect());
</script>

{#if rendered.blockedImages > 0 && !allowRemote && policy !== "never"}
  <div class="blocked">
    <ImageOff size={14} />
    <span>Remote images hidden to protect your privacy.</span>
    <button class="btn sm" onclick={() => (allowOnce = true)}>Load images</button>
  </div>
{/if}

<div class="frame-wrap" class:paper={rendered.designed || app.settings?.ui.mailRendering !== "adaptive"}>
  <iframe
    bind:this={frame}
    title="Message body"
    sandbox="allow-same-origin"
    srcdoc={rendered.srcdoc}
    style:height="{height}px"
    {onload}></iframe>
</div>

<style>
  .blocked {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px 7px 12px;
    margin-bottom: 12px;
    border-radius: var(--r);
    font-size: 12px;
    color: var(--fg-dim);
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .blocked span {
    flex: 1;
  }
  .frame-wrap {
    border-radius: var(--r-lg);
    overflow: hidden;
  }
  .frame-wrap.paper {
    background: #fff;
    box-shadow: 0 1px 0 rgb(255 255 255 / 0.04) inset, var(--shadow-sm);
  }
  iframe {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    color-scheme: normal;
  }
</style>
