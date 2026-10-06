// Agent panel state: wraps AgentSession and turns its events into a transcript.
import { AgentSession, type AgentEvent } from "$lib/ai";
import { app } from "./app.svelte";
import { composer } from "./composer.svelte";
import { calendar } from "./calendar.svelte";
import { toasts } from "./toasts.svelte";

export type AgentItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool"; id: number; callId: string; name: string; label: string; status: "running" | "ok" | "error"; summary: string }
  | {
      kind: "approval";
      id: number;
      callId: string;
      name: string;
      label: string;
      preview: string;
      state: "pending" | "approved" | "denied";
    }
  | { kind: "error"; id: number; text: string };

let seq = 0;

class AgentState {
  items = $state<AgentItem[]>([]);
  busy = $state(false);
  thinking = $state(false);
  pendingApproval = $derived(
    this.items.find((i): i is Extract<AgentItem, { kind: "approval" }> => i.kind === "approval" && i.state === "pending") ?? null,
  );

  private session: AgentSession | null = null;

  private ensure(): AgentSession {
    if (!this.session) {
      this.session = new AgentSession({
        onEvent: (e) => this.handle(e),
        context: () => ({
          accountId: app.accountFilter,
          openMessageId: app.open?.id ?? null,
          view: app.view.kind === "results" ? undefined : app.view,
        }),
      });
    }
    return this.session;
  }

  private lastAssistant(): Extract<AgentItem, { kind: "assistant" }> | null {
    const last = this.items[this.items.length - 1];
    return last && last.kind === "assistant" ? last : null;
  }

  private handle(e: AgentEvent) {
    switch (e.type) {
      case "thinking":
        this.thinking = true;
        break;
      case "text": {
        this.thinking = false;
        const last = this.lastAssistant();
        if (last) last.text += e.delta;
        else this.items.push({ kind: "assistant", id: ++seq, text: e.delta });
        break;
      }
      case "tool_start":
        this.thinking = false;
        this.items.push({
          kind: "tool",
          id: ++seq,
          callId: e.id,
          name: e.name,
          label: e.label,
          status: "running",
          summary: "",
        });
        break;
      case "approval":
        this.thinking = false;
        this.items.push({
          kind: "approval",
          id: ++seq,
          callId: e.id,
          name: e.name,
          label: e.label,
          preview: e.preview,
          state: "pending",
        });
        break;
      case "tool_end": {
        const t = this.items.find((i) => i.kind === "tool" && i.callId === e.id);
        if (t && t.kind === "tool") {
          t.status = e.ok ? "ok" : "error";
          t.summary = e.summary;
        } else {
          // tool_end after an approval: append a result row
          this.items.push({
            kind: "tool",
            id: ++seq,
            callId: e.id,
            name: "",
            label: e.summary,
            status: e.ok ? "ok" : "error",
            summary: "",
          });
        }
        if (e.ok) app.scheduleRefresh();
        break;
      }
      case "ui":
        this.handleUi(e.action);
        break;
      case "done":
        this.busy = false;
        this.thinking = false;
        break;
      case "error":
        this.busy = false;
        this.thinking = false;
        this.items.push({ kind: "error", id: ++seq, text: e.message });
        break;
    }
  }

  private handleUi(action: Extract<AgentEvent, { type: "ui" }>["action"]) {
    switch (action.kind) {
      case "open_message":
        app.select(action.id);
        break;
      case "compose":
        composer.compose(action.draft);
        break;
      case "show_results":
        app.showResults(action.title, action.ids);
        break;
      case "open_event": {
        const show = () => {
          if (calendar.events.some((e) => e.id === action.id)) {
            app.setView({ kind: "calendar" });
            const ev = calendar.events.find((e) => e.id === action.id);
            if (ev) calendar.goto(new Date(ev.start));
            calendar.openDetails(action.id);
          } else toasts.show("Event created — it will appear in the calendar after the next sync", { kind: "success" });
        };
        if (calendar.events.some((e) => e.id === action.id)) show();
        else calendar.load({ silent: true }).then(show);
        break;
      }
    }
  }

  async send(text: string) {
    const t = text.trim();
    if (!t || this.busy) return;
    this.items.push({ kind: "user", id: ++seq, text: t });
    this.busy = true;
    this.thinking = true;
    app.agentOpen = true;
    try {
      await this.ensure().send(t);
    } catch (e) {
      this.handle({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
      this.thinking = false;
    }
  }

  resolve(callId: string, approved: boolean) {
    const item = this.items.find((i) => i.kind === "approval" && i.callId === callId);
    if (item && item.kind === "approval") item.state = approved ? "approved" : "denied";
    this.session?.resolveApproval(callId, approved);
  }

  abort() {
    this.session?.abort();
    this.busy = false;
    this.thinking = false;
  }

  reset() {
    this.session?.abort();
    this.session?.reset();
    this.items = [];
    this.busy = false;
    this.thinking = false;
  }
}

export const agent = new AgentState();
