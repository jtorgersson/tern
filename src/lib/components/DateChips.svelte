<script lang="ts">
  // Dates mentioned in an email ("next Thursday at 14:00", "fredag 10/10 kl 9") become one-click "Create event"
  // chips. Deterministic, local: the quick-add parser runs over sentences that mention a date.
  import { app } from "$lib/state/app.svelte";
  import { calendar } from "$lib/state/calendar.svelte";
  import type { MessageFull } from "$lib/types";
  import { parseQuickAdd, type QuickAdd } from "$lib/util/quickadd";
  import { toLocalIso, whenLabel } from "$lib/util/cal";
  import { CalendarPlus } from "@lucide/svelte";

  let { message }: { message: MessageFull } = $props();

  const DATE_HINT =
    /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|(?<![\p{L}])(må|tis|ons|tors?|fre|lör|sön)[a-zåäö]*(?![\p{L}])|\b(today|tomorrow|idag|imorgon|övermorgon|next|nästa)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)[a-z]*\b/iu;
  const TIME_HINT = /\b(kl\.?|at)\s*\d{1,2}\b|\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(am|pm)\b/i;

  interface Chip {
    key: string;
    q: QuickAdd;
    snippet: string;
  }

  const chips = $derived.by<Chip[]>(() => {
    const text = (message.bodyText || message.preview || "").slice(0, 12_000);
    const received = new Date(message.receivedAt);
    const out: Chip[] = [];
    const seen = new Set<string>();
    // Sentences / lines that mention a date; the parser needs a time too, or the chip becomes an all-day event.
    for (const raw of text.split(/(?<=[.!?\n])\s+|\n+/)) {
      const s = raw.trim();
      if (s.length < 6 || s.length > 220 || !DATE_HINT.test(s)) continue;
      const q = parseQuickAdd(s, received, 60);
      if (!q || !q.matched.date) continue;
      if (!q.matched.time && !TIME_HINT.test(s)) continue; // dates without a time are usually not appointments
      if (q.start.getTime() < Date.now() - 86_400_000) continue; // already past
      const key = toLocalIso(q.start);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, q, snippet: s.length > 90 ? s.slice(0, 88) + "…" : s });
      if (out.length >= 3) break;
    }
    return out;
  });

  function create(c: Chip) {
    const me = new Set(app.ownAccounts.map((a) => a.email.toLowerCase()));
    const sender = me.has(message.from.email.toLowerCase()) ? [] : [message.from];
    calendar.openComposer({
      accountId: message.accountId,
      subject: message.subject.replace(/^(re|sv|fw|fwd|vb):\s*/i, "") || c.q.subject,
      start: toLocalIso(c.q.start),
      end: toLocalIso(c.q.end),
      isAllDay: c.q.allDay,
      attendees: sender,
      isOnline: c.q.isOnline,
      location: c.q.location,
      body: `From the email “${message.subject}”:\n“${c.snippet}”`,
    });
  }
</script>

{#if chips.length}
  <div class="chips">
    {#each chips as c (c.key)}
      <button class="chip" onclick={() => create(c)} title={c.snippet}>
        <CalendarPlus size={12} />
        <span class="when">{whenLabel({ start: toLocalIso(c.q.start), end: toLocalIso(c.q.end), isAllDay: c.q.allDay })}</span>
        <span class="add">Create event</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 0 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 10px 0 9px;
    border-radius: 999px;
    font-size: 11.5px;
    color: var(--fg);
    background: color-mix(in oklab, var(--blue) 12%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--blue) 30%, transparent);
    transition: all var(--t);
  }
  .chip:hover {
    background: color-mix(in oklab, var(--blue) 22%, transparent);
  }
  .when {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .add {
    font-weight: 600;
    color: color-mix(in oklab, var(--blue) 80%, var(--fg));
  }
</style>
