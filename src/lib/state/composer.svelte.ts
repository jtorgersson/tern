// Composer state + delayed (undoable) send.
import { api } from "$lib/api";
import type { Addr, ComposeMode, MessageFull, OutgoingMessage } from "$lib/types";
import { app } from "./app.svelte";
import { toasts } from "./toasts.svelte";
import { errMsg, escapeHtml, textToHtml } from "$lib/util/misc";
import { longTime } from "$lib/util/time";

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
}

const SEND_DELAY = 5000;

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

class Composer {
  draft = $state<Draft | null>(null);
  open = $derived(this.draft !== null);
  minimized = $state(false);
  /** AI streaming into the body. */
  aiBusy = $state(false);
  sending = $state(false);
  /** Bumped when body should be re-pushed into the editor (AI wrote into it). */
  bodyVersion = $state(0);

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
    };
    this.minimized = false;
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

  close() {
    this.aiAbort?.abort();
    this.draft = null;
    this.aiBusy = false;
  }

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
    };
  }

  /** `at` = send later (Exchange delivers it then, even with Tern closed). */
  send(at: Date | null = null) {
    const d = this.draft;
    if (!d) return;
    if (!d.to.length && !d.cc.length && !d.bcc.length) {
      toasts.error("Add at least one recipient");
      return;
    }
    const snapshot = $state.snapshot(d) as Draft;
    snapshot.ref = d.ref; // keep reference (not proxied)
    const out = this.build(snapshot);
    if (at) {
      if (at.getTime() < Date.now() + 2 * 60_000) {
        toasts.error("Pick a time at least a few minutes from now");
        return;
      }
      out.sendAt = at.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    this.close();
    const when = at ? `${at.toLocaleDateString("en-CA")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "";

    let cancelled = false;
    const id = toasts.show(at ? `Scheduling for ${when}…` : "Sending…", {
      kind: "progress",
      timeout: 0,
      action: {
        label: "Undo",
        run: () => {
          cancelled = true;
          toasts.dismiss(id);
          this.draft = snapshot;
          this.bodyVersion++;
        },
      },
    });
    setTimeout(async () => {
      if (cancelled) return;
      toasts.update(id, { action: undefined });
      try {
        await api.send(out);
        toasts.update(id, { kind: "success", text: at ? `Scheduled — Outlook will send it ${when}` : "Sent", timeout: at ? 5000 : 2500 });
        app.scheduleRefresh();
        if (out.refMessageId && (out.mode === "reply" || out.mode === "replyAll")) {
          import("./today.svelte").then(({ today }) => today.clearReply(out.refMessageId!));
        }
      } catch (e) {
        toasts.update(id, {
          kind: "error",
          text: `Send failed: ${errMsg(e)}`,
          timeout: 0,
          action: {
            label: "Reopen",
            run: () => {
              toasts.dismiss(id);
              this.draft = snapshot;
              this.bodyVersion++;
            },
          },
        });
      }
    }, SEND_DELAY);
  }
}

export const composer = new Composer();
