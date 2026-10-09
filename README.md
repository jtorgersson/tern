# Tern

AI-native, keyboard-first mail, calendar, and conversations for Omarchy. It's built with Tauri 2, Rust, and Svelte 5.

- **Microsoft 365 / Outlook.com** via Microsoft Graph. Multiple accounts and a unified inbox are supported, and delta sync runs every 60s.
- **Connect:** Microsoft Teams chats and channels beside your mail or calendar (`g b`). Read and send messages, browse channel threads, and reply without switching apps. Resize the dock or expand it; conversation drafts survive navigation and closing the dock during the session. Create chats with new people or groups, draft replies with AI, catch up on a thread, and turn conversations into email or meeting drafts. Calls and attachments open in Teams. Work or school accounts only; enable access per account.
- **One search across your day:** the top search field (`/`) returns mail, calendar events, and Connect messages together, with source tabs and account filtering. Connect results search Microsoft’s index, including conversations you haven’t opened in Tern.
- **Your Omarchy theme, live.** Colors come from `~/.local/state/omarchy/current/theme/colors.toml` and update when you switch themes. The window is translucent, so Hyprland blur shows through.
- **AI that does the work:**
  - Triage sorts mail into *Needs reply / Action / FYI / Newsletters / Notifications / Receipts*.
  - It also writes thread TL;DRs on request, drafts replies in your voice, and rewrites text. The mail reader focuses on the selected email, with collapsed related emails below it. **Summarize thread** (`t`) and **Draft with AI** reveal the assistant when needed. Reply and forward badges appear in the inbox and reader after successful sends, and are also read from Outlook’s response metadata.
  - A **Today** view opens with a streamed briefing of what matters, replies Tern drafted ahead of time for mail that needs an answer, mail you sent that nobody answered yet (with one-click nudges), and deadlines it spotted.
  - **Calendar:** a full calendar (`g c`) with day, week, month and agenda views over any date range, all your Outlook calendars (own and shared, toggle each on/off), drag to move or resize, double-click to create, recurring events, optional attendees, show-as / reminder / private, quick add in plain English or Swedish ("Styrelsemöte fre 14-15:30"), invitation cards with Accept / Tentative / Decline that warn about conflicts, meeting reminders with a Join button, and an agent that lists, finds free times, creates, moves, reschedules and cancels events (each change with your approval).
  - **Meeting prep, automatically:** open any meeting and Tern pulls the related mail from the people in it and streams a short brief — what it's about, what to know, what to prepare, what's still open.
  - **Dates in mail become events:** "next Thursday at 14:00" in an email shows a one-click *Create event* chip; invitations get a real *Propose a new time* (sent to the organizer as a counter-proposal).
  - **Scheduling helpers:** one-click private focus blocks from free gaps, *Share my availability* composes an email with your free slots, a *Next up* pill in the top bar counts down to your next meeting with Join, keyboard time cursor on the week grid (arrows, Enter), event search over everything cached (`/`), and a lock toggle to make any event private.
  - **Insights:** a calendar view (`i`) with your week against your usual — time in meetings, focus time, back-to-back runs — a 12-week meeting heatmap, when your meetings happen, who you meet most, meeting sizes, and an AI time coach.
  - **Scheduling assistant:** when you invite people, the composer shows everyone's free/busy for the day (work and school accounts); click a slot to move the meeting there.
  - **Meeting notes:** private notes on any event, and a one-click follow-up email to the attendees drafted from them.
  - **Calendar comfort:** second time zone in the week grid, speedy meetings (end 5 or 10 min early), one-click reschedule (+1 h, tomorrow, next week, `[` `]`), and `g j` joins the current or next meeting from anywhere.
- **Snooze** (`z`): hide mail until later today, tomorrow, the weekend, next week or any time; it comes back unread with a notification. **Send later**: Outlook holds the message and sends it on time even with Tern closed. **Unsubscribe** from mailing lists in one click (RFC 8058), then archive everything else from that sender.
- **Background bodies:** recent mail bodies are downloaded after each sync, so messages open instantly and full-text search covers bodies (Settings → Sync).
- **Swedish time conventions:** 24-hour clock everywhere (never AM/PM), weeks start on Monday, ISO week numbers. Day and month names in English or Swedish (Settings → Appearance).
  - An **agent** (`Ctrl+J`) can search, read, archive, flag, move, draft, schedule and respond to invites for you. Sending, deleting, creating events and responding to invitations always ask first.
- **AI providers:** Anthropic (Claude, default `claude-opus-5-5`) or any OpenAI-compatible API (OpenAI, Ollama, LM Studio, OpenRouter, Groq…). Keys live in gnome-keyring.
- **Local-first:** SQLite cache with full-text search at `~/.local/share/tern/tern.db`. Settings are in `~/.config/tern/settings.json`.

## 1. Register the Microsoft app (one time, ~3 minutes)

Tern is a *public client*, so it has no secret. You need a client ID from an Entra ID app registration.

1. Go to <https://entra.microsoft.com> → **Identity → Applications → App registrations → New registration**.
2. **Name:** `Tern`.
   **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*. This lets one client ID serve every M365 tenant and Outlook.com. Pick *single tenant* if your IT prefers.
3. **Redirect URI:** platform **Public client/native (mobile & desktop)**, value `http://localhost`. Tern listens on a random loopback port; Entra allows any port for `http://localhost`.
4. Open **Authentication** and set **Allow public client flows** to **Yes**. Save.
5. Under **API permissions → Add → Microsoft Graph → Delegated**, add: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.Read`, `Calendars.ReadWrite`, `offline_access`, `openid`, `profile`, `email`.
   If your tenant restricts user consent, click **Grant admin consent**.
6. Copy the **Application (client) ID**. Paste it on Tern's welcome screen, then **Sign in with Microsoft**.

To add more accounts, go to Settings → Accounts → *Add Microsoft account*. Other tenants work too, provided the registration is multi-tenant and their admins allow it.

## Connect with Microsoft Teams

Connect is Tern’s conversation workspace. Open **Connect** in the sidebar, use the toolbar’s conversation button, or press **g b**. It stays open as you switch between your inbox and calendar; drag the divider to resize it or use Expand to focus on conversations. On smaller windows the mail sidebar is hidden while docked; the command palette and navigation shortcuts remain available.

In your existing Entra app registration, add these **Microsoft Graph → Delegated** permissions:

- `Chat.Read`, `ChatMessage.Send`, `Chat.Create`, `User.ReadBasic.All`
- `Team.ReadBasic.All`, `Channel.ReadBasic.All`
- `ChannelMessage.Read.All`, `ChannelMessage.Send`

Then choose your work or school account in Connect and click **Enable Connect**. Sign in as the same account and organization. Channel access can require administrator consent; if Microsoft blocks approval, ask your administrator to approve the permissions. **Reconnect** retries consent after permissions change. Regular mail/calendar sign-in does not request these optional permissions.

Chats and channels use your existing Teams conversations. The selected conversation refreshes every 15 seconds while Connect is open and Tern is visible; the conversation list refreshes every minute. Use **Load more** for earlier messages and additional conversations. **Ctrl+Enter** sends; Enter adds a line. Failed sends retain the draft and are not automatically retried, since delivery can be uncertain.

Use **+ New conversation** to find people in your organization by name or email. Select one person to open/reuse their direct chat, or several to create a named group. The new permissions are `Chat.Create` and `User.ReadBasic.All`; existing Connect users see **Enable new conversations** before using the picker. The upgrade keeps existing read/send consent intact until you approve the new permissions. Directory availability and guest/external access depend on Microsoft tenant policy.

The smile button in mail and chat opens a searchable emoji picker. Emoji are inserted at the cursor, replacing selected text; arrow keys navigate the picker, Enter selects, and Escape closes it.

**Writing assistant** uses your configured AI provider to stream reply suggestions. Add an instruction, choose **Shorter**, **Warmer**, or **Ask a question**, then review and use the suggestion. Existing drafts are replaced only when you click **Replace draft**. **Catch me up** summarizes loaded messages, decisions, and next steps; you can turn the brief into a meeting draft. The context is limited to the most recent 40 loaded, non-deleted messages (up to 18,000 characters), not the entire unseen history. The open email is included only if you check its checkbox. AI never sends messages or books meetings.

**Discuss in Connect** in the mail reader opens the person picker with the sender (or recipient for your sent mail) and an editable excerpt of the email. **Email** in a conversation prepares an email addressed to the known chat participants; **Plan meeting** prepares an online calendar event. These handoffs use the same Microsoft account and leave the result for you to review. Existing email/event drafts are preserved. **Quote in reply** brings the selected message into the composer; in channels it opens the message’s thread.

The main search field searches all three sources on Enter. Tabs narrow the displayed results; the account selector limits the search. Mail and calendar searches cover locally downloaded data (calendar shows up to 200 closest matches); Connect searches Microsoft’s live index in every enabled account, with pagination and independent errors/retry per account. Recent messages may take time to appear in Microsoft’s index. Selecting a result opens its email, calendar event, or exact Connect message. **Related** searches across all three sources using the current conversation title.

This integration handles text messages, channel posts, threaded replies, new chats/groups, and AI writing. Calls, joining meetings, and file access hand off to Teams. Chats show unread dots and an Unread filter using Teams read receipts plus account-specific reading progress saved locally by Tern. New-message dividers and Jump to latest help you catch up without losing your place. Reading in Tern does not update read receipts in Teams; channels only track new messages after they have been opened in Tern. Presence, reactions, typing indicators, and push notifications are not implemented. Messages and drafts are kept in memory for this session, without an offline Teams cache. Microsoft’s Teams chat/channel APIs do not support personal Microsoft accounts.

API references: [chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0), [sending messages](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0), [channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0).

## 2. AI

Set this up in Settings → AI, or in the second onboarding step:
- **Anthropic:** paste an API key from <https://console.anthropic.com>.
- **OpenAI-compatible:** enter a base URL, e.g. `https://api.openai.com/v1` or `http://localhost:11434/v1` for Ollama. Add a key and a model if needed.

Mail content is treated as untrusted data in every prompt. The agent can't send or delete without your explicit approval.

## Run / install

```bash
bun install
bun tauri dev            # development
./scripts/install.sh     # release build → ~/.local/bin/tern + launcher entry
```

On NVIDIA + Wayland, if the window renders blank, start Tern with `TERN_NO_DMABUF=1 tern`.

## Keys

| | |
|---|---|
| `j` / `k` | next / previous |
| `Enter` / `o` | open |
| `e` | archive |
| `#` | delete |
| `s` | flag |
| `u` | toggle read |
| `r` / `Shift+R` / `f` | reply / reply all / forward |
| `c` | compose |
| `/` | search mail, calendar, and Connect |
| `g t` / `g c` / `g i` / `g s` / `g d` / `g x` | today / calendar / inbox / sent / drafts / trash |
| `d` / `w` / `m` / `a` | calendar: day / week / month / agenda |
| `h` / `l`, `t` | calendar: previous / next period, today |
| `n`, `e`, `#` | calendar: new event, edit, delete |
| `i`, `[` / `]` | calendar: insights, move selected event a day |
| `z`, `g z` | snooze, snoozed mail |
| `g b` | open / close Connect beside mail and calendar |
| `g j` | join the current / next meeting |
| `Ctrl+K` | command palette |
| `Ctrl+J` | agent |
| `?` | all shortcuts |

See `ARCHITECTURE.md` for internals.
