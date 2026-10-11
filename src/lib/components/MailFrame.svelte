<script lang="ts">
  import { app } from "$lib/state/app.svelte";
  import { renderMail } from "$lib/util/html";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { ImageOff } from "@lucide/svelte";

  export interface HoverLink {
    href: string;
    /** Visible link text (for spotting links that say one site and go to another). */
    text: string;
  }

  let { html, onlink }: { html: string; onlink?: (link: HoverLink | null) => void } = $props();

  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(120);
  let allowOnce = $state(false);

  const policy = $derived(app.settings?.ui.remoteImages ?? "ask");
  const allowRemote = $derived(policy === "always" || allowOnce);

  const rendered = $derived.by(() => {
    void app.theme; // re-render on theme / contrast change
    void app.settings?.ui.contrast;
    const cs = getComputedStyle(document.documentElement);
    return renderMail(html, {
      allowRemote,
      mode: app.settings?.ui.mailRendering ?? "adaptive",
      fg: cs.getPropertyValue("--fg").trim() || "#ddd",
      link: cs.getPropertyValue("--accent").trim() || "#7aa2f7",
      font: `"Adwaita Sans", "Inter", system-ui, sans-serif`,
      scale: app.readerScale,
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
      const target = e.target as HTMLElement;
      const toggle = target.closest?.(".tern-quote-toggle");
      if (toggle) {
        e.preventDefault();
        const quote = toggle.nextElementSibling as HTMLElement | null;
        if (quote) {
          quote.hidden = !quote.hidden;
          toggle.textContent = quote.hidden ? "··· Show quoted text" : "Hide quoted text";
          requestAnimationFrame(measure);
        }
        return;
      }
      const a = target.closest?.("a");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (/^(https?|mailto|tel):/i.test(href)) openUrl(href).catch(() => {});
    });
    // Link destinations show in the reader while hovering (the iframe can't show a status bar of its own).
    doc.addEventListener("mouseover", (e) => {
      const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      const href = a?.getAttribute("href") ?? "";
      onlink?.(a && /^(https?|mailto|tel):/i.test(href) ? { href, text: (a.textContent ?? "").trim() } : null);
    });
    doc.documentElement.addEventListener("mouseleave", () => onlink?.(null));
  }

  $effect(() => () => {
    ro?.disconnect();
    onlink?.(null);
  });
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
