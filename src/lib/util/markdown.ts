import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";

marked.setOptions({ gfm: true, breaks: true });

export function md(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style", "iframe", "form"] });
}

/** onclick handler for containers with rendered markdown: opens links externally. */
export function mdLinkHandler(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (a?.href) {
    e.preventDefault();
    if (/^(https?|mailto):/i.test(a.href)) openUrl(a.href).catch(() => {});
  }
}
