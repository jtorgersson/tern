/** Add an inclusive range in display order. A missing anchor selects only the target. */
export function selectRange(ids: string[], selected: Set<string>, anchor: string | null, target: string): Set<string> {
  const end = ids.indexOf(target);
  if (end < 0) return new Set(selected);
  const start = anchor ? ids.indexOf(anchor) : -1;
  return new Set([...selected, ...ids.slice(start < 0 ? end : Math.min(start, end), Math.max(start, end) + 1)]);
}
