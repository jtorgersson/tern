// AgentSession: a multi-turn, tool-using conversation with approval gates.
import { api } from "../api";
import type { Account, MessageSummary, MessageView, OutgoingMessage } from "../types";
import type { AgentDriver, ToolCall, ToolResult } from "./backend";
import { settings } from "./config";
import { friendlyError, isAbort } from "./errors";
import { accountsLine, addr, nowLine, truncate } from "./format";
import { AGENT_SYSTEM, aboutMeBlock } from "./prompts";
import { backend } from "./providers";
import { TOOL_BY_NAME, TOOL_SPECS, type ToolCtx } from "./tools";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking" }
  | { type: "tool_start"; id: string; name: string; label: string; input: unknown }
  | { type: "approval"; id: string; name: string; label: string; input: unknown; preview: string }
  | { type: "tool_end"; id: string; ok: boolean; summary: string }
  | {
      type: "ui";
      action:
        | { kind: "open_message"; id: string }
        | { kind: "compose"; draft: Partial<OutgoingMessage> }
        | { kind: "show_results"; title: string; ids: string[] };
    }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AgentContext {
  accountId?: string | null;
  openMessageId?: string | null;
  view?: MessageView;
}

const MAX_STEPS = 25;
const RESULT_LIMIT = 40_000;

export class AgentSession {
  private driver: AgentDriver | null = null;
  private driverKey = "";
  private controller: AbortController | null = null;
  private approvals = new Map<string, (ok: boolean) => void>();
  private known = new Map<string, MessageSummary>();
  private busy = false;
  private wroteText = false;

  constructor(private opts: { onEvent: (e: AgentEvent) => void; context?: () => AgentContext }) {}

  get running(): boolean {
    return this.busy;
  }

  async send(text: string): Promise<void> {
    if (this.busy) {
      this.emit({ type: "error", message: "Still working on the previous request." });
      return;
    }
    this.busy = true;
    this.wroteText = false;
    const controller = (this.controller = new AbortController());
    let provider;
    try {
      const b = await backend("main");
      provider = b.provider;
      const key = `${b.provider.id}|${b.provider.kind}|${b.model}`;
      if (!this.driver || key !== this.driverKey) {
        this.driver = b.agent();
        this.driverKey = key;
      }
      const accounts = await api.accounts();
      this.driver.pushUser(await this.contextBlock(accounts), text);
      await this.loop(this.driver, controller.signal, accounts);
      this.emit({ type: "done" });
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) this.emit({ type: "done" });
      else this.emit({ type: "error", message: friendlyError(err, provider) });
    } finally {
      this.busy = false;
      this.cancelApprovals();
      if (this.controller === controller) this.controller = null;
    }
  }

  resolveApproval(callId: string, approved: boolean): void {
    const r = this.approvals.get(callId);
    if (r) {
      this.approvals.delete(callId);
      r(approved);
    }
  }

  abort(): void {
    this.controller?.abort();
    this.cancelApprovals();
  }

  reset(): void {
    this.abort();
    this.driver = null;
    this.driverKey = "";
    this.known.clear();
  }

  private emit(e: AgentEvent) {
    try {
      this.opts.onEvent(e);
    } catch (err) {
      console.error("agent onEvent handler failed", err);
    }
  }

  private cancelApprovals() {
    for (const r of this.approvals.values()) r(false);
    this.approvals.clear();
  }

  private async loop(driver: AgentDriver, signal: AbortSignal, accounts: Account[]) {
    const system = AGENT_SYSTEM + "\n\n" + aboutMeBlock(settings().ai.aboutMe);
    const ctx: ToolCtx = {
      ui: (action) => this.emit({ type: "ui", action }),
      accounts: async () => accounts,
      known: this.known,
      defaultAccountId: this.opts.context?.().accountId ?? accounts[0]?.id ?? null,
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      this.emit({ type: "thinking" });
      let firstDelta = true;
      const r = await driver.turn({
        system,
        tools: TOOL_SPECS,
        signal,
        onThinking: () => this.emit({ type: "thinking" }),
        onText: (delta) => {
          if (firstDelta && this.wroteText) delta = "\n\n" + delta;
          firstDelta = false;
          this.wroteText = true;
          this.emit({ type: "text", delta });
        },
      });

      if (r.stop === "refusal") {
        this.emit({ type: "text", delta: (this.wroteText ? "\n\n" : "") + "_The model declined this request._" });
        return;
      }
      if (r.stop === "max_tokens") {
        this.emit({ type: "text", delta: "\n\n_(Response was cut off.)_" });
        return;
      }
      if (r.stop !== "tool_use") return;

      // Every tool_use must get a result, even when cancelled, so history stays valid.
      const results: ToolResult[] = [];
      for (const call of r.calls) {
        if (signal.aborted) results.push({ id: call.id, content: "Cancelled by the user.", isError: true });
        else results.push(await this.runTool(call, ctx));
      }
      driver.pushToolResults(results);
      if (signal.aborted) return;
    }
    this.emit({ type: "text", delta: `\n\n_(Stopped after ${MAX_STEPS} steps.)_` });
  }

  private async runTool(call: ToolCall, ctx: ToolCtx): Promise<ToolResult> {
    const def = TOOL_BY_NAME.get(call.name);
    if (!def) return { id: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    if (call.input === undefined)
      return { id: call.id, content: "INVALID_JSON: tool input could not be parsed; please retry.", isError: true };
    const parsed = def.schema.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return { id: call.id, content: `Invalid input: ${issues}`, isError: true };
    }
    const input = parsed.data;
    let label: string;
    try {
      label = def.label(input, ctx);
    } catch {
      label = call.name;
    }

    const needsApproval =
      def.approval === "always" || (def.approval === "safe" && !settings().ai.autoApproveSafeActions);
    if (needsApproval) {
      let preview = label;
      try {
        preview = (await def.preview?.(input, ctx)) ?? label;
      } catch (err) {
        return { id: call.id, content: `Error: ${(err as Error).message}`, isError: true };
      }
      const ok = await new Promise<boolean>((res) => {
        this.approvals.set(call.id, res);
        this.emit({ type: "approval", id: call.id, name: call.name, label, input, preview });
      });
      if (!ok) {
        this.emit({ type: "tool_end", id: call.id, ok: false, summary: "Declined" });
        return { id: call.id, content: "The user declined this action. Do not retry it unless they ask.", isError: false };
      }
    }

    this.emit({ type: "tool_start", id: call.id, name: call.name, label, input });
    try {
      const out = await def.run(input, ctx);
      let content = typeof out === "string" ? out : JSON.stringify(out);
      if (content.length > RESULT_LIMIT) content = content.slice(0, RESULT_LIMIT) + "\n[…result truncated]";
      this.emit({ type: "tool_end", id: call.id, ok: true, summary: summarize(out) });
      return { id: call.id, content, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ type: "tool_end", id: call.id, ok: false, summary: truncate(msg, 120) });
      return { id: call.id, content: `Error: ${msg}`, isError: true };
    }
  }

  private async contextBlock(accounts: Account[]): Promise<string> {
    const c = this.opts.context?.() ?? {};
    const lines = [`Now: ${nowLine()}`, `Accounts: ${accountsLine(accounts) || "(none)"}`];
    if (c.view) lines.push(`Current view: ${describeView(c.view)}`);
    if (c.accountId) lines.push(`Current account: ${c.accountId}`);
    if (c.openMessageId) {
      let m = this.known.get(c.openMessageId);
      if (!m) {
        try {
          m = await api.message(c.openMessageId);
          this.known.set(m.id, m);
        } catch {
          /* message may be gone */
        }
      }
      if (m) lines.push(`Open message: id=${m.id} from ${addr(m.from)}, subject "${truncate(m.subject, 120)}"`);
    }
    return `<context>\n${lines.join("\n")}\n</context>`;
  }
}

function describeView(v: MessageView): string {
  switch (v.kind) {
    case "today": return "Today (briefing / proactive overview)";
    case "folder": return `folder ${v.folderId}`;
    case "unified": return `${v.wellKnown} (all accounts)`;
    case "flagged": return "flagged";
    case "category": return `AI category ${v.category}`;
    case "search": return `search "${v.query}"`;
  }
}

function summarize(out: unknown): string {
  if (typeof out === "string") return truncate(out.split("\n")[0] ?? "", 100);
  if (Array.isArray(out)) return `${out.length} item${out.length === 1 ? "" : "s"}`;
  if (out && typeof out === "object" && "count" in out) {
    const c = (out as { count: number }).count;
    return c === 0 ? "No results" : `${c} result${c === 1 ? "" : "s"}`;
  }
  return "Done";
}
