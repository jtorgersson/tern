# Tern

AI-native, keyboard-first mail for Omarchy. It's built with Tauri 2, Rust, and Svelte 5.

- **Microsoft 365 / Outlook.com** via Microsoft Graph. Multiple accounts and a unified inbox are supported, and delta sync runs every 60s.
- **Your Omarchy theme, live.** Colors come from `~/.local/state/omarchy/current/theme/colors.toml` and update when you switch themes. The window is translucent, so Hyprland blur shows through.
- **AI that does the work:**
  - Triage sorts mail into *Needs reply / Action / FYI / Newsletters / Notifications / Receipts*.
  - It also writes thread TL;DRs, drafts replies in your voice, and rewrites text.
  - A **Today** view opens with a streamed briefing of what matters, replies Tern drafted ahead of time for mail that needs an answer, mail you sent that nobody answered yet (with one-click nudges), and deadlines it spotted.
  - **Calendar:** a full calendar (`g c`) with day, week, month and agenda views over any date range, all your Outlook calendars (own and shared, toggle each on/off), drag to move or resize, double-click to create, recurring events, optional attendees, show-as / reminder / private, quick add in plain English or Swedish ("Styrelsemöte fre 14-15:30"), invitation cards with Accept / Tentative / Decline that warn about conflicts, meeting reminders with a Join button, and an agent that lists, finds free times, creates, moves, reschedules and cancels events (each change with your approval).
  - **Meeting prep, automatically:** open any meeting and Tern pulls the related mail from the people in it and streams a short brief — what it's about, what to know, what to prepare, what's still open.
  - **Dates in mail become events:** "next Thursday at 14:00" in an email shows a one-click *Create event* chip; invitations get a real *Propose a new time* (sent to the organizer as a counter-proposal).
  - **Scheduling helpers:** one-click private focus blocks from free gaps, *Share my availability* composes an email with your free slots, a *Next up* pill in the top bar counts down to your next meeting with Join, keyboard time cursor on the week grid (arrows, Enter), event search over everything cached (`/`), and a lock toggle to make any event private.
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
| `/` | search |
| `g t` / `g c` / `g i` / `g s` / `g d` / `g x` | today / calendar / inbox / sent / drafts / trash |
| `d` / `w` / `m` / `a` | calendar: day / week / month / agenda |
| `h` / `l`, `t` | calendar: previous / next period, today |
| `n`, `e`, `#` | calendar: new event, edit, delete |
| `Ctrl+K` | command palette |
| `Ctrl+J` | agent |
| `?` | all shortcuts |

See `ARCHITECTURE.md` for internals.
