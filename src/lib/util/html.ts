// Email HTML → safe iframe srcdoc.
import DOMPurify from "dompurify";

export interface RenderedMail {
  srcdoc: string;
  blockedImages: number;
  /** True when the mail paints its own backgrounds (we then always use the paper card). */
  designed: boolean;
}

export interface RenderOptions {
  allowRemote: boolean;
  mode: "paper" | "adaptive";
  /** Theme colors for adaptive mode. */
  fg: string;
  link: string;
  font: string;
}

const REMOTE = /^(https?:)?\/\//i;

export function renderMail(html: string, opts: RenderOptions): RenderedMail {
  let blockedImages = 0;

  const isPlain = !/<[a-z][\s\S]*>/i.test(html);
  const source = isPlain
    ? `<div style="white-space:pre-wrap">${html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>`
    : html;

  DOMPurify.removeAllHooks();
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    if (!opts.allowRemote) {
      for (const attr of ["src", "background", "poster"]) {
        const v = el.getAttribute(attr);
        if (v && REMOTE.test(v)) {
          el.setAttribute(`data-blocked-${attr}`, v);
          el.removeAttribute(attr);
          if (el.tagName === "IMG") blockedImages++;
        }
      }
      if (el.tagName === "IMG" && el.getAttribute("srcset")) el.removeAttribute("srcset");
      const style = el.getAttribute("style");
      if (style && /url\(\s*['"]?(https?:)?\/\//i.test(style)) {
        el.setAttribute("style", style.replace(/url\(\s*['"]?(https?:)?\/\/[^)]*\)/gi, "none"));
        blockedImages++;
      }
    }
  });

  const clean = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: false,
    FORCE_BODY: true,
    ADD_TAGS: ["style", "center", "font"],
    ADD_ATTR: ["target", "bgcolor", "background", "align", "valign", "cellpadding", "cellspacing", "border", "width", "height", "color", "face", "size"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "meta", "link", "base"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  }) as string;

  DOMPurify.removeAllHooks();

  // Remote @import / url() inside <style> blocks.
  const styled = opts.allowRemote
    ? clean
    : clean
        .replace(/@import[^;]+;/gi, "")
        .replace(/url\(\s*['"]?(https?:)?\/\/[^)]*\)/gi, "none");

  const designed =
    !isPlain &&
    (/bgcolor\s*=\s*["']?#?(?!fff|ffffff|white)/i.test(styled) ||
      /background(-color)?\s*:\s*(?!transparent|#fff\b|#ffffff\b|white\b|none)[#a-z]/i.test(styled));

  const paper = opts.mode === "paper" || designed;
  const imgSrc = opts.allowRemote ? "data: blob: https: http:" : "data: blob:";
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data: ${opts.allowRemote ? "https:" : ""}; media-src data:`;

  const base = `
    html,body{margin:0;padding:0;}
    body{font-family:${opts.font};font-size:14.5px;line-height:1.55;word-wrap:break-word;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;}
    img{max-width:100%;height:auto;}
    table{max-width:100%;}
    pre,code{white-space:pre-wrap;font-family:"JetBrains Mono Variable",monospace;font-size:12.5px;}
    blockquote{margin:0.6em 0;padding-left:12px;border-left:3px solid rgba(127,127,127,.35);opacity:.85;}
    a{word-break:break-word;}
    img[data-blocked-src]{display:none;}img[data-blocked-src][width]:not([width="0"]):not([width="1"]){display:inline-block;min-height:16px;background:rgba(127,127,127,.12);border-radius:4px;}
  `;
  const theme = paper
    ? `body{background:#ffffff;color:#1d2228;padding:28px 32px;} a{color:#2259c7;}`
    : `body{background:transparent;color:${opts.fg};padding:4px 2px;} a{color:${opts.link};}
       font[color],[style*="color"]{color:inherit !important;}
       hr{border:0;border-top:1px solid rgba(127,127,127,.25);}`;

  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${base}${theme}</style></head><body>${styled}</body></html>`;

  return { srcdoc, blockedImages, designed };
}
