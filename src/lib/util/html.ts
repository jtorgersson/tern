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
  /** Text zoom (1 = normal). */
  scale?: number;
  /** Fold the quoted earlier messages behind a "Show quoted text" toggle (default true). */
  collapseQuotes?: boolean;
}

/** Markers mail clients put on the quoted earlier conversation, most specific first. */
const QUOTE_SELECTORS = [
  "blockquote[type=cite]",
  ".gmail_quote",
  "#divRplyFwdMsg",
  "#x_divRplyFwdMsg",
  "#appendonsend",
  ".yahoo_quoted",
  ".moz-cite-prefix",
  "blockquote.protonmail_quote",
  "[id^=mail-editor-reference-message-container]",
  "#reply-intro",
  ".zmail_extra",
];
const OUTLOOK_HEAD = /^(From|Från|Von|De|Fra):/;
const OUTLOOK_HEAD_FIELDS = [/(Sent|Skickat|Gesendet|Date|Datum|Envoyé):/, /(Subject|Ämne|Betreff|Objet|Emne):/];
const WROTE = /(wrote|skrev|schrieb|a écrit|escribió):?\s*$/;

function hasContentBefore(node: Element): boolean {
  for (let p = node.previousSibling; p; p = p.previousSibling) {
    if (p.nodeType === Node.TEXT_NODE && (p.textContent ?? "").trim()) return true;
    if (p.nodeType === Node.ELEMENT_NODE) {
      const el = p as Element;
      if ((el.textContent ?? "").trim() || el.querySelector("img")) return true;
    }
  }
  return false;
}

/** The element where the quoted earlier conversation starts, or null. */
function findQuoteStart(body: HTMLElement): Element | null {
  for (const sel of QUOTE_SELECTORS) {
    const el = body.querySelector(sel);
    if (el) return el;
  }
  // Outlook desktop / mobile: a header block "From: … Sent: … Subject: …" followed by the old mail.
  for (const el of body.querySelectorAll("div, p, table")) {
    const t = (el.textContent ?? "").trim();
    if (t.length < 700 && OUTLOOK_HEAD.test(t) && OUTLOOK_HEAD_FIELDS.every((re) => re.test(t))) return el;
  }
  // "On <date>, <name> wrote:" line right before a blockquote (Apple Mail, Thunderbird, Gmail plain text).
  for (const bq of body.querySelectorAll("blockquote")) {
    const prev = bq.previousElementSibling;
    if (prev && WROTE.test((prev.textContent ?? "").trim().slice(-40))) return prev;
  }
  return null;
}

/**
 * Moves the quoted earlier messages into a hidden `.tern-quote` block behind a toggle, so a reply
 * shows just the new words. Nothing is removed: the toggle reveals it. Leaves the mail alone when the
 * whole body is a quote (a forward without comment) or no quote is recognized.
 */
export function collapseQuotedText(body: HTMLElement): boolean {
  const start = findQuoteStart(body);
  if (!start) return false;
  // Climb while nothing precedes the node in its parent: the wrapper div is part of the quote.
  let node: Element = start;
  while (node.parentElement && node.parentElement !== body && !hasContentBefore(node)) node = node.parentElement;
  if (!hasContentBefore(node)) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  const doc = body.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.className = "tern-quote";
  wrap.setAttribute("hidden", "");
  const toggle = doc.createElement("button");
  toggle.className = "tern-quote-toggle";
  toggle.type = "button";
  toggle.textContent = "··· Show quoted text";
  parent.insertBefore(toggle, node);
  parent.insertBefore(wrap, node);
  let n: ChildNode | null = node;
  while (n) {
    const next: ChildNode | null = n.nextSibling;
    wrap.appendChild(n);
    n = next;
  }
  if (!(wrap.textContent ?? "").trim() && !wrap.querySelector("img")) {
    // Nothing worth hiding: undo.
    while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
    wrap.remove();
    toggle.remove();
    return false;
  }
  return true;
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

  // Fold the quoted earlier messages (post-sanitize: our own toggle button must survive).
  let folded = styled;
  if (opts.collapseQuotes !== false) {
    try {
      const doc = new DOMParser().parseFromString(`<!doctype html><body>${styled}`, "text/html");
      if (collapseQuotedText(doc.body)) folded = doc.body.innerHTML;
    } catch {
      folded = styled;
    }
  }

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
    .tern-quote[hidden]{display:none;}
    .tern-quote-toggle{display:inline-block;margin:10px 0 4px;padding:3px 10px;border:0;border-radius:999px;font:inherit;font-size:11.5px;letter-spacing:.01em;cursor:pointer;color:rgba(127,127,127,1);background:rgba(127,127,127,.14);}
    .tern-quote-toggle:hover{background:rgba(127,127,127,.24);}
    .tern-quote{margin-top:8px;}
    body{zoom:${opts.scale && opts.scale !== 1 ? opts.scale : 1};}
  `;
  const theme = paper
    ? `body{background:#ffffff;color:#1d2228;padding:28px 32px;} a{color:#2259c7;}`
    : `body{background:transparent;color:${opts.fg};padding:4px 2px;} a{color:${opts.link};}
       font[color],[style*="color"]{color:inherit !important;}
       hr{border:0;border-top:1px solid rgba(127,127,127,.25);}`;

  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${base}${theme}</style></head><body>${folded}</body></html>`;

  return { srcdoc, blockedImages, designed };
}
