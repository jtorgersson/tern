<script lang="ts">
  // One attachment in the reader: click opens it with the system's default app; images show a thumbnail.
  import { api } from "$lib/api";
  import { toasts } from "$lib/state/toasts.svelte";
  import { formatBytes, errMsg } from "$lib/util/misc";
  import type { Attachment, MessageFull } from "$lib/types";
  import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
  import { Download, LoaderCircle, FileText, FileSpreadsheet, FileArchive, Image as ImageIcon, File as FileIcon, Presentation } from "@lucide/svelte";

  let { message, attachment }: { message: MessageFull; attachment: Attachment } = $props();

  let preview = $state<string | null>(null);
  let busy = $state<"open" | "save" | null>(null);

  const isImage = $derived(attachment.contentType.startsWith("image/") && !attachment.contentType.includes("svg"));

  const Icon = $derived.by(() => {
    const t = attachment.contentType.toLowerCase();
    const n = attachment.name.toLowerCase();
    if (isImage) return ImageIcon;
    if (t.includes("spreadsheet") || t.includes("excel") || /\.(xlsx?|csv)$/.test(n)) return FileSpreadsheet;
    if (t.includes("presentation") || t.includes("powerpoint") || /\.pptx?$/.test(n)) return Presentation;
    if (t.includes("zip") || t.includes("compressed") || t.includes("tar") || /\.(zip|7z|rar|gz|tgz)$/.test(n)) return FileArchive;
    if (t.includes("pdf") || t.includes("text") || t.includes("document") || t.includes("word") || /\.(pdf|docx?|txt|md)$/.test(n)) return FileText;
    return FileIcon;
  });

  $effect(() => {
    const [mid, aid] = [message.id, attachment.id];
    preview = null;
    if (!isImage) return;
    let live = true;
    api.attachmentPreview(mid, aid).then((url) => live && (preview = url)).catch(() => {});
    return () => {
      live = false;
    };
  });

  async function open() {
    if (busy) return;
    busy = "open";
    try {
      const path = await api.attachmentOpen(message.id, attachment.id);
      await openPath(path).catch(() => revealItemInDir(path));
    } catch (e) {
      toasts.error(`Could not open ${attachment.name}: ${errMsg(e)}`);
    } finally {
      busy = null;
    }
  }

  async function save(e: Event) {
    e.stopPropagation();
    if (busy) return;
    busy = "save";
    try {
      const path = await api.saveAttachment(message.id, attachment.id);
      toasts.show(`Saved ${attachment.name} to Downloads`, {
        kind: "success",
        timeout: 8000,
        action: { label: "Show", run: () => revealItemInDir(path).catch(() => openPath(path)) },
      });
    } catch (e) {
      toasts.error(`Could not save ${attachment.name}: ${errMsg(e)}`);
    } finally {
      busy = null;
    }
  }
</script>

<div class="att" class:image={!!preview} role="group" aria-label={attachment.name}>
  <button class="main" onclick={open} title="Open {attachment.name}">
    {#if preview}
      <img src={preview} alt={attachment.name} loading="lazy" />
    {:else}
      <span class="att-ic"><Icon size={15} /></span>
    {/if}
    <span class="meta">
      <span class="att-name">{attachment.name}</span>
      <span class="att-size mono">{formatBytes(attachment.size)}</span>
    </span>
    {#if busy === "open"}<LoaderCircle size={13} class="spin" />{/if}
  </button>
  <button class="save" onclick={save} title="Save to Downloads" aria-label="Save {attachment.name} to Downloads" disabled={!!busy}>
    {#if busy === "save"}<LoaderCircle size={13} class="spin" />{:else}<Download size={13} />{/if}
  </button>
</div>

<style>
  .att {
    position: relative;
    display: flex;
    align-items: stretch;
    max-width: 320px;
    border-radius: 10px;
    background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--line);
    transition: box-shadow var(--t);
    overflow: hidden;
  }
  .att:hover {
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .main {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    flex: 1;
    height: 36px;
    padding: 0 8px 0 6px;
    text-align: left;
  }
  .image .main {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    height: auto;
    padding: 0;
    width: 200px;
  }
  .image img {
    display: block;
    width: 100%;
    height: 120px;
    object-fit: cover;
    background: var(--bg-darker);
  }
  .image .meta {
    padding: 7px 10px;
  }
  .att-ic {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--accent-soft);
    color: var(--accent);
    flex: none;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .att-name {
    font-size: 12.5px;
    color: var(--fg);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .att-size {
    font-size: 10.5px;
    color: var(--muted);
    flex: none;
  }
  .save {
    display: grid;
    place-items: center;
    width: 30px;
    flex: none;
    color: var(--muted);
    border-left: 1px solid var(--line);
    opacity: 0;
    transition: opacity var(--t);
  }
  .image .save {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 7px;
    background: color-mix(in oklab, var(--bg) 75%, transparent);
    color: var(--fg);
  }
  .att:hover .save,
  .att:focus-within .save {
    opacity: 1;
  }
  .save:hover {
    color: var(--accent);
    background: var(--hover);
  }
</style>
