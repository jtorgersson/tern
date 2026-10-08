import { api } from "$lib/api";
import { connectApi, searchPage, type ConnectSearchHit } from "$lib/connect";
import type { CalEvent, MessageSummary } from "$lib/types";
import { app } from "./app.svelte";
import { errMsg } from "$lib/util/misc";

export type SearchKind = "all" | "mail" | "calendar" | "connect";
export interface AccountSearch { accountId: string; hits: ConnectSearchHit[]; from: number; more: boolean; loading: boolean; error: string }
class SearchState {
  open = $state(false);
  query = $state("");
  tab = $state<SearchKind>("all");
  accountId = $state<string | null>(null);
  mail = $state<MessageSummary[]>([]);
  events = $state<CalEvent[]>([]);
  conversations = $state<AccountSearch[]>([]);
  mailLoading = $state(false);
  calendarLoading = $state(false);
  mailError = $state("");
  calendarError = $state("");
  mailMore = $state(false);
  private generation = 0;
  close() { this.open = false; }
  async run(query: string) {
    const q = query.trim();
    const seq = ++this.generation;
    this.query = q;
    if (!q) { this.open = false; return; }
    this.open = true;
    this.mail = [];
    this.events = [];
    this.mailError = this.calendarError = "";
    this.mailLoading = this.calendarLoading = true;
    this.mailMore = false;
    const id = this.accountId;
    this.conversations = app.ownAccounts.filter(a => a.connectConsent && (!id || a.id === id)).map(a => ({ accountId: a.id, hits: [], from: 0, more: false, loading: true, error: "" }));
    await Promise.allSettled([
      (async () => {
        try {
          const list = await api.messages({ view: { kind: "search", query: q }, accountId: id, limit: 50 });
          if (seq !== this.generation) return;
          this.mail = list; this.mailMore = list.length === 50;
        } catch (e) { if (seq === this.generation) this.mailError = errMsg(e); }
        finally { if (seq === this.generation) this.mailLoading = false; }
      })(),
      (async () => {
        try { const list = await api.calendarSearch(q, 200, id); if (seq === this.generation) this.events = list; }
        catch (e) { if (seq === this.generation) this.calendarError = errMsg(e); }
        finally { if (seq === this.generation) this.calendarLoading = false; }
      })(),
      ...this.conversations.map(a => this.loadConnect(a.accountId, false, seq)),
    ]);
  }
  async moreMail() {
    if (this.mailLoading || !this.mailMore) return;
    const seq = this.generation;
    this.mailLoading = true;
    try {
      const list = await api.messages({ view: { kind: "search", query: this.query }, accountId: this.accountId, limit: 50, before: this.mail.at(-1)?.receivedAt });
      if (seq !== this.generation) return;
      this.mail = [...new Map([...this.mail, ...list].map(m => [m.id, m])).values()];
      this.mailMore = list.length === 50;
    } catch (e) { if (seq === this.generation) this.mailError = errMsg(e); }
    finally { if (seq === this.generation) this.mailLoading = false; }
  }
  async loadConnect(accountId: string, more = false, seq = this.generation) {
    const row = this.conversations.find(a => a.accountId === accountId);
    if (!row || (more && row.loading)) return;
    row.loading = true;
    row.error = "";
    try {
      const page = searchPage(await connectApi.search(accountId, this.query, more ? row.from : 0));
      if (seq !== this.generation) return;
      row.hits = more ? [...new Map([...row.hits, ...page.hits].map(h => [h.hitId, h])).values()] : page.hits;
      row.from = (more ? row.from : 0) + 25;
      row.more = page.more && row.from <= 1000;
    } catch (e) { if (seq === this.generation) row.error = errMsg(e); }
    finally { if (seq === this.generation) row.loading = false; }
  }
}
export const search = new SearchState();
