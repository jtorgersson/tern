# Tern automation

Tern 0.4.0 includes a native MCP server and a private HTTP API. Both run without
opening a window and share the desktop application's Microsoft accounts, SQLite
cache, timezone, and system-keyring credentials. No OpenAI API key is needed.

## Install and connect Codex

```bash
./scripts/install.sh --register-mcp
```

This installs the release binary and registers `~/.local/bin/tern --mcp` as the
`tern` MCP server in your Codex configuration. Each connection starts its own
process; no HTTP daemon is required. Start a new Codex session after registration.
To register an already installed binary:

```bash
./scripts/register-mcp.sh
codex mcp get tern
```

Other MCP clients can launch the same binary with `--mcp`. The Rust MCP SDK
(`rmcp`) implements newline-delimited JSON-RPC over stdin/stdout. stdout contains
only protocol messages; diagnostics go to stderr. The desktop single-instance
plugin is not started, so the desktop and MCP server can run together.

Ask Codex: “Use Tern to tell me what my day looks like.” It should call
`get_status`, `list_accounts`, and `list_calendar_events` for today's local range
with `refresh: true`, then explain the events and any refresh warnings.

## Tools and HTTP operations

The API and MCP server share argument schemas and a service dispatcher.
Arguments use camelCase, matching Tern's desktop API; results are JSON objects.
MCP `tools/list` and HTTP `GET /v1/tools` expose the full schemas and annotations.

| Operation | Behavior |
| --- | --- |
| `get_status` | Current local time, timezone, version, account status and last sync |
| `list_accounts` | Signed-in accounts and capability/consent flags |
| `list_folders`, `list_calendars` | Cached folders/calendars, optionally filtered by `accountId` |
| `list_calendar_events` | Overlapping events between local `from` and exclusive `to`; optional `refresh` |
| `search_calendar_events`, `get_calendar_event` | Cached event search; full live event body and recurrence |
| `create_calendar_event`, `find_free_slots` | Create events/invitations; find available local times |
| `search_email` | Cached full-text/operator search; empty query lists recent inbox mail |
| `get_email`, `get_email_thread` | Load email bodies; read up to 50 cached conversation messages |
| `create_email_draft`, `send_email_draft` | Create an Outlook draft; separately send an existing draft |
| `send_email`, `reply_to_email` | Send new plain-text email or reply to the original sender |
| `list_conversations` | Live Teams chats, teams, channels, members, messages and replies |
| `search_messages`, `get_message` | Live Teams index search and specific message reads |
| `send_message`, `search_people` | Send to a chat/channel/thread; find people in the organization |

### Time, freshness and pagination

`get_status` returns an RFC3339 `now` and IANA `timeZone`. Calendar bounds and
creation times use local `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS` in that zone.
Offsets and ambiguous/nonexistent daylight-saving times are rejected. Ranges
must be positive and at most 400 days. Event objects include their timezone.

`list_calendar_events` with `refresh: true` downloads each selected account's
calendar list and range before querying the cache. `refreshedAccounts` identifies
successes; `warnings` identifies failures and cached fallbacks. An empty cache
after a failed refresh does not establish availability.

Mail search uses the desktop's local cache. Keep Tern running for normal mail
sync; headless processes do not start the desktop sync loop. Check account
`lastSync` from `get_status`. Email body reads do not mark messages read.
Thread results report unavailable bodies and explicitly identify the cached
scope; they do not claim complete server history.

`find_free_slots` reports its source. If Microsoft's live free/busy is unavailable,
it returns a warning that slots use only the account's cached events and that
attendee availability could not be verified. Busy all-day events block slots.

Mail/calendar search `limit` is 1–100 (default 25). To paginate mail, supply both
values from `nextCursor` as `before` and `beforeId` with the same query/account.
Equal timestamps use message IDs as a stable tie-breaker. Mail operators include
`from:`, `to:`, `subject:`, `is:unread`, `is:flagged`, `in:`, `before:`, `after:`
and `has:attachment`.

Teams retains Tern's per-account Connect consent and work/school restrictions.
Example `list_conversations` arguments:

```json
{"accountId":"ms-…","resource":{"kind":"chats"}}
```

```json
{"accountId":"ms-…","resource":{"kind":"chat","chatId":"19:…@thread.v2"}}
```

Other kinds: `teams`, `members` (`chatId`), `channels` (`teamId`), `channel`
(`teamId`, `channelId`), and `replies` (`teamId`, `channelId`, `messageId`).
Pass the returned `@odata.nextLink` as `next` with the same resource to paginate.
Links to other hosts or resources are rejected.

### Writes

Draft creation never sends. Email recipient objects use `name` and `email`;
the body is plain text. For example, call `create_email_draft` with:

```json
{
  "accountId": "ms-…",
  "to": [{ "name": "Anna", "email": "anna@example.com" }],
  "subject": "Tomorrow's meeting",
  "body": "Can we start at 10:00?"
}
```

It returns `draftId` and `webLink` for review in Outlook. When sending is
requested, call `send_email_draft` with the `accountId` and `draftId`.
`send_email`, `reply_to_email`, and `send_message` transmit immediately and are
advertised as writes. Calendar creation immediately invites any attendees.

Send POSTs run once, without automatic retries after network/server errors.
A successful Microsoft 202 response means accepted, not guaranteed delivery.
For uncertain failures, inspect Sent Items/the conversation before retrying.
Event creation includes a Graph transaction ID to deduplicate transient retries.
Cache failures after successful writes are warnings rather than send failures.

## Private HTTP API

```bash
tern --api                 # 127.0.0.1:17273
tern --api 18080           # choose another port
```

First startup creates `~/.config/tern/api-token` with permission 0600. Set
`TERN_API_TOKEN` to a secret of at least 32 characters to supply your own token.
The token is never printed. Every endpoint requires bearer authentication.
The server binds only to IPv4 loopback, requires the exact `127.0.0.1:PORT` Host,
rejects browser Origin headers, and limits request bodies to 1 MiB.

```bash
# Read the credential locally; do not put it in source control or chat.
tern_api_token=$(cat "$HOME/.config/tern/api-token")
curl -H "Authorization: Bearer $tern_api_token" \
  http://127.0.0.1:17273/v1/status

curl -H "Authorization: Bearer $tern_api_token" \
  -H 'Content-Type: application/json' \
  -d '{"from":"2026-10-13","to":"2026-10-14","refresh":true}' \
  http://127.0.0.1:17273/v1/list_calendar_events
```

`GET /v1/status` and `GET /v1/accounts` are convenient read endpoints.
`POST /v1/OPERATION` invokes any listed operation with its JSON arguments.
Validation errors return 400, missing resources/operations 404, backend failures
502. Application errors use `{"error":{"code":"…","message":"…"}}`.
MCP tool failures return `isError: true` and readable error content.

The HTTP API is not an HTTP MCP endpoint. For ChatGPT web, connect the native
stdio server through a supported private MCP tunnel, or deploy a separately
authenticated remote MCP service. Local Codex registration does not configure
ChatGPT web.

## Verify changes

```bash
bun run check
bun test src
cargo test --manifest-path src-tauri/Cargo.toml
```

Rust tests exercise MCP initialization/discovery, tool errors, HTTP auth and
Origin/Host rejection, account-bound reads/replies, equal-timestamp pagination,
and overlapping calendar ranges. They use an in-memory database and never send
real mail or messages.
