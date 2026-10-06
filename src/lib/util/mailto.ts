import type { Addr, OutgoingMessage } from "$lib/types";
import { escapeHtml } from "./misc";

const addrs = (s: string | null): Addr[] =>
  (s ?? "")
    .split(/[,;]/)
    .map((e) => decodeURIComponent(e).trim())
    .filter(Boolean)
    .map((email) => ({ name: "", email }));

/** Parses an RFC 6068 mailto: URL into a draft. */
export function parseMailto(url: string): Partial<OutgoingMessage> {
  const rest = url.replace(/^mailto:/i, "");
  const [to, query = ""] = rest.split("?", 2);
  const q = new URLSearchParams(query);
  const body = q.get("body");
  return {
    mode: "new",
    to: addrs(to),
    cc: addrs(q.get("cc")),
    bcc: addrs(q.get("bcc")),
    subject: q.get("subject") ?? "",
    bodyHtml: body ? escapeHtml(body).replace(/\r?\n/g, "<br>") : "",
  };
}
