// Composer state + delayed (undoable) send, attachments and local draft autosave.
import { api } from "$lib/api";
import type { Addr, ComposeMode, MessageFull, OutgoingAttachment, OutgoingMessage } from "$lib/types";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";
import { errMsg, escapeHtml, formatBytes, htmlToText, textToHtml } from "$lib/util/misc";
import { longTime } from "$lib/util/time";

export interface DraftAttachment extends OutgoingAttachment {
  id: string;
  size: number;
}

export interface Draft {
  accountId: string;
  mode: ComposeMode;
  refMessageId: string | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  /** Body HTML as edited by the user (signature + quote are appended on send). */
  bodyHtml: string;
  /** Read-only quoted original for replies/forwards. */
  quoteHtml: string;
  showCc: boolean;
  /** Message being replied to (for AI context). */
  ref: MessageFull | null;
  attachments: DraftAttachment[];
}

const SEND_DELAY = 5000;
/** Per file and per message (base64 travels through the Tauri IPC in one piece). */
export const ATTACHMENT_FILE_MAX = 25 * 1024 * 1024;
export const ATTACHMENT_TOTAL_MAX = 40 * 1024 * 1024;
/** Local autosave: the draft is written here while you type and restored after a restart. */
const DRAFT_KEY = "tern.draft";
/** Attachment bytes are only autosaved up to this total; above it you re-attach after a restart. */
const SAVED_ATTACHMENTS_MAX = 2 * 1024 * 1024;
/** Words that usually mean "there should be a file on this email" (English and Swedish). */
const MENTIONS_ATTACHMENT = /\b(attach(ed|ment|ments|ing)?|enclosed|bifoga[drst]*|bilag(a|an|or|orna))\b/i;

function prefix(subject: string, p: "Re" | "Fwd"): string {
  const re = new RegExp(`^\\s*(${p}|${p === "Re" ? "SV|AW" : "FW|VB|WG"})\\s*:`, "i");
  return re.test(subject) ? subject : `${p}: ${subject}`;
}

function quoteBlock(m: MessageFull, forward: boolean): string {
  const from = escapeHtml(m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email);
  const head = forward
    ? `<p>---------- Forwarded message ----------<br>From: ${from}<br>Date: ${escapeHtml(longTime(m.receivedAt))}<br>Subject: ${escapeHtml(m.subject)}<br>To: ${escapeHtml(m.to.map((a) => a.email).join(", "))}</p>`
    : `<p>On ${escapeHtml(longTime(m.receivedAt))}, ${from} wrote:</p>`;
  return `${head}<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${m.bodyHtml}</blockquote>`;
}

/** True when the draft holds anything worth keeping. */
export function hasContent(d: Draft): boolean {
  return !!(d.subject.trim() || d.to.length || d.cc.length || d.bcc.length || d.attachments.length || htmlToText(d.bodyHtml).trim());
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.readAsDataURL(file);
  });
}

class Composer {
  draft = $state<Draft | null>(null);
  open = $derived(this.draft !== null);
  minimized = $state(false);
  /** AI streaming into the body. */
  aiBusy = $state(false);
  sending = $state(false);
  /** Bumped when body should be re-pushed into the editor (AI wrote into it). */
  bodyVersion = $state(0);
  /** Set when the text mentions an attachment but none is attached; Send asks once. */
  attachWarning = $state(false);
  /** Files being read from disk. */
  attaching = $state(0);

  private defaultAccount(): string {
    return app.defaultMailAccount();
  }

  compose(partial: Partial<OutgoingMessage> & { ref?: MessageFull | null } = {}) {
    this.draft = {
      accountId: partial.accountId ?? this.defaultAccount(),
      mode: partial.mode ?? "new",
      refMessageId: partial.refMessageId ?? null,
      to: partial.to ?? [],
      cc: partial.cc ?? [],
      bcc: partial.bcc ?? [],
      subject: partial.subject ?? "",
      bodyHtml: partial.bodyHtml ?? "",
      quoteHtml: "",
      showCc: (partial.cc?.length ?? 0) + (partial.bcc?.length ?? 0) > 0,
      ref: partial.ref ?? null,
      attachments: [],
    };
    this.minimized = false;
    this.attachWarning = false;
    this.bodyVersion++;
  }

  reply(m: MessageFull, mode: "reply" | "replyAll" | "forward", bodyHtml = "") {
    const me = app.accountById.get(m.accountId)?.email.toLowerCase();
    const notMe = (a: Addr) => a.email.toLowerCase() !== me;
    let to: Addr[] = [];
    let cc: Addr[] = [];
    if (mode !== "forward") {
      to = m.replyTo.length ? m.replyTo : [m.from];
      if (mode === "replyAll") {
        const seen = new Set(to.map((a) => a.email.toLowerCase()));
        cc = [...m.to, ...m.cc].filter((a) => notMe(a) && !seen.has(a.email.toLowerCase()));
      }
      // Replying to my own sent message: reply to original recipients instead.
      if (!notMe(m.from)) to = m.to.filter(notMe);
    }
    this.compose({
      accountId: m.accountId,
      mode,
      refMessageId: m.id,
      to,
      cc,
      subject: prefix(m.subject, mode === "forward" ? "Fwd" : "Re"),
      bodyHtml,
      ref: m,
    });
    if (this.draft) this.draft.quoteHtml = quoteBlock(m, mode === "forward");
  }

  /** Close without keeping anything (used after a send). */
  close() {
    this.aiAbort?.abort();
    this.draft = null;
    this.aiBusy = false;
    this.attachWarning = false;
    this.clearSaved();
  }

  /** Close from the X / trash button: a draft with content can be brought back from the toast. */
  discard() {
    const d = this.draft;
    if (!d || !hasContent(d)) return this.close();
    const snapshot = this.snapshot(d);
    this.close();
    toasts.show("Draft discarded", {
      kind: "success",
      timeout: 8000,
      action: {
        label: "Undo",
        run: () => {
          this.draft = snapshot;
          this.minimized = false;
          this.bodyVersion++;
        },
      },
    });
  }

  private snapshot(d: Draft): Draft {
    const s = $state.snapshot(d) as Draft;
    s.ref = d.ref; // keep reference (not proxied)
    return s;
  }

  // ---------------- attachments ----------------

  async addFiles(files: Iterable<File>) {
    const d = this.draft;
    if (!d) return;
    const list = [...files].filter((f) => f.size > 0 || f.type);
    if (!list.length) return;
    this.attaching += list.length;
    try {
      for (const f of list) {
        const total = d.attachments.reduce((n, a) => n + a.size, 0);
        if (f.size > ATTACHMENT_FILE_MAX) {
          toasts.error(`${f.name} is ${formatBytes(f.size)}; files up to ${formatBytes(ATTACHMENT_FILE_MAX)} can be attached`);
          continue;
        }
        if (total + f.size > ATTACHMENT_TOTAL_MAX) {
          toasts.error(`Attachments can total ${formatBytes(ATTACHMENT_TOTAL_MAX)} per email`);
          break;
        }
        try {
          const data = await readBase64(f);
          if (!this.draft) return;
          this.draft.attachments.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: f.name || "file",
            contentType: f.type || "application/octet-stream",
            size: f.size,
            data,
          });
          this.attachWarning = false;
        } catch (e) {
          toasts.error(errMsg(e));
        }
      }
    } finally {
      this.attaching = Math.max(0, this.attaching - list.length);
    }
  }

  removeAttachment(id: string) {
    if (this.draft) this.draft.attachments = this.draft.attachments.filter((a) => a.id !== id);
  }

  // ---------------- local autosave ----------------

  /** Writes the draft to localStorage (called, debounced, from the composer while you type). */
  persist() {
    if (app.windowKind !== "main") return;
    const d = this.draft;
    try {
      if (!d || !hasContent(d)) return localStorage.removeItem(DRAFT_KEY);
      const { ref: _ref, attachments, ...rest } = $state.snapshot(d) as Draft;
      const keep = attachments.reduce((n, a) => n + a.size, 0) <= SAVED_ATTACHMENTS_MAX;
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ ...rest, attachments: keep ? attachments : [], attachmentsDropped: !keep && attachments.length > 0, savedAt: Date.now() }),
      );
    } catch {
      // Storage full or unavailable: the in-memory draft is unaffected.
    }
  }

  private clearSaved() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }

  /** On startup: bring back a draft that was open when Tern last closed (minimized, so it does not get in the way). */
  async restore() {
    if (app.windowKind !== "main" || this.draft) return;
    let saved: (Omit<Draft, "ref"> & { attachmentsDropped?: boolean }) | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    } catch {}
    if (!saved || !Array.isArray(saved.to)) return;
    if (!app.accountById.has(saved.accountId)) saved.accountId = this.defaultAccount();
    const d: Draft = { ...saved, ref: null, attachments: saved.attachments ?? [] };
    if (!hasContent(d)) return this.clearSaved();
    this.draft = d;
    this.minimized = true;
    this.bodyVersion++;
    if (d.refMessageId) api.message(d.refMessageId).then((m) => this.draft && this.draft.refMessageId === m.id && (this.draft.ref = m)).catch(() => {});
    toasts.show(saved.attachmentsDropped ? "Restored your unsent draft (re-attach the files)" : "Restored your unsent draft", {
      kind: "success",
      timeout: 8000,
      action: { label: "Open", run: () => (this.minimized = false) },
    });
  }

  // ---------------- AI ----------------

  private aiAbort: AbortController | null = null;

  /** Stream AI plain-text output into the body (replacing it). */
  async streamBody(make: (signal: AbortSignal) => AsyncIterable<string>) {
    if (!this.draft) return;
    this.aiAbort?.abort();
    const ctrl = new AbortController();
    this.aiAbort = ctrl;
    this.aiBusy = true;
    const before = this.draft.bodyHtml;
    let acc = "";
    try {
      for await (const delta of make(ctrl.signal)) {
        if (ctrl.signal.aborted || !this.draft) break;
        acc += delta;
        this.setBody(textToHtml(acc));
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        toasts.error(`AI: ${errMsg(e)}`);
        if (!acc && this.draft) this.setBody(before);
      }
    } finally {
      if (this.aiAbort === ctrl) {
        this.aiBusy = false;
        this.aiAbort = null;
      }
    }
  }

  stopAi() {
    this.aiAbort?.abort();
    this.aiBusy = false;
  }

  setBody(html: string) {
    if (!this.draft) return;
    this.draft.bodyHtml = html;
    this.bodyVersion++;
  }

  // ---------------- send ----------------

  /** Assemble the outgoing message. Graph's reply endpoints add the quote themselves. */
  private build(d: Draft): OutgoingMessage {
    const sig = app.settings?.signatures?.[d.accountId]?.trim();
    let body = d.bodyHtml;
    if (sig) body += `<br><div class="tern-signature">${sig}</div>`;
    if (d.mode === "new" && d.quoteHtml) body += `<br>${d.quoteHtml}`;
    return {
      accountId: d.accountId,
      mode: d.mode,
      refMessageId: d.refMessageId,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      bodyHtml: body,
      attachments: d.attachments.map(({ name, contentType, data }) => ({ name, contentType, data })),
    };
  }

  /** True for replies: the original can be archived once the reply is on its way. */
  canArchive = $derived(!!this.draft && this.draft.mode !== "new" && this.draft.mode !== "forward" && !!this.draft.refMessageId);

  /**
   * `at` = send later (Exchange delivers it then, even with Tern closed).
   * `archive` = also archive the message being replied to.
   * `force` = skip the forgot-the-attachment check.
   */
  send(at: Date | null = null, opts: { archive?: boolean; force?: boolean } = {}) {
    const d = this.draft;
    if (!d) return;
    if (this.attaching) {
      toasts.error("Still reading the files you attached…");
      return;
    }
    if (!d.to.length && !d.cc.length && !d.bcc.length) {
      toasts.error("Add at least one recipient");
      return;
    }
    if (!opts.force && !d.attachments.length && d.mode !== "forward" && MENTIONS_ATTACHMENT.test(htmlToText(d.bodyHtml))) {
      this.attachWarning = true;
      return;
    }
    this.attachWarning = false;
    const snapshot = this.snapshot(d);
    const out = this.build(snapshot);
    if (at) {
      if (at.getTime() < Date.now() + 2 * 60_000) {
        toasts.error("Pick a time at least a few minutes from now");
        return;
      }
      out.sendAt = at.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    const archiveId = opts.archive && this.canArchive ? snapshot.refMessageId : null;
    this.close();
    const when = at ? `${at.toLocaleDateString("en-CA")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "";

    let cancelled = false;
    const reopen = () => {
      toasts.dismiss(id);
      this.draft = snapshot;
      this.minimized = false;
      this.bodyVersion++;
    };
    const id = toasts.show(at ? `Scheduling for ${when}…` : "Sending…", {
      kind: "progress",
      timeout: 0,
      action: {
        label: "Undo",
        run: () => {
          cancelled = true;
          reopen();
        },
      },
    });
    setTimeout(async () => {
      if (cancelled) return;
      toasts.update(id, { action: undefined });
      try {
        await api.send(out);
        if (!at && out.refMessageId && out.mode !== "new") app.recordResponse(out.refMessageId, out.mode);
        const sent = at ? `Scheduled — Outlook will send it ${when}` : "Sent";
        toasts.update(id, { kind: "success", text: archiveId ? `${sent} · archived` : sent, timeout: at ? 5000 : 2500 });
        if (archiveId) void app.archive([archiveId], true);
        app.scheduleRefresh();
        if (out.refMessageId && (out.mode === "reply" || out.mode === "replyAll")) {
          import("./today.svelte").then(({ today }) => today.clearReply(out.refMessageId!));
        }
      } catch (e) {
        toasts.update(id, {
          kind: "error",
          text: `Send failed: ${errMsg(e)}`,
          timeout: 0,
          action: { label: "Reopen", run: reopen },
        });
      }
    }, SEND_DELAY);
  }
}

export const composer = new Composer();
