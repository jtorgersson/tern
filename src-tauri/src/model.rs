//! Types shared with the frontend. Mirror of src/lib/types.ts.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: String,
    pub email: String,
    pub display_name: String,
    pub hue: i64,
    pub tenant_id: Option<String>,
    pub last_sync: Option<String>,
    pub status: String,
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub well_known: Option<String>,
    pub parent_id: Option<String>,
    pub unread: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Addr {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub message_id: String,
    pub category: String,
    pub priority: i64,
    pub summary: String,
    pub action_items: Vec<String>,
    pub needs_reply: bool,
    pub due_at: Option<String>,
    #[serde(default)]
    pub suggested_reply: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub conversation_id: String,
    pub subject: String,
    pub from: Addr,
    pub to: Vec<Addr>,
    pub preview: String,
    pub received_at: String,
    pub is_read: bool,
    pub is_flagged: bool,
    pub has_attachments: bool,
    pub importance: String,
    pub meeting_type: Option<String>,
    pub ai: Option<Annotation>,
    /// UTC ISO time the message is snoozed until (hidden from mailbox views until then).
    #[serde(default)]
    pub snoozed_until: Option<String>,
}

/// List-Unsubscribe info from the message headers (RFC 2369 / RFC 8058).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Unsubscribe {
    /// https link (opened in the browser, or POSTed when `one_click`).
    pub url: Option<String>,
    /// mailto: link.
    pub mailto: Option<String>,
    /// RFC 8058 one-click: a POST to `url` unsubscribes without a web page.
    pub one_click: bool,
}

/// Free/busy of one person from getSchedule. `view` has one digit per interval: 0 free, 1 tentative, 2 busy, 3 oof, 4 elsewhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub email: String,
    pub view: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: i64,
    pub content_type: String,
    pub is_inline: bool,
    pub content_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageFull {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub cc: Vec<Addr>,
    pub bcc: Vec<Addr>,
    pub reply_to: Vec<Addr>,
    pub body_html: String,
    pub body_text: String,
    pub attachments: Vec<Attachment>,
    pub web_link: Option<String>,
    #[serde(default)]
    pub unsubscribe: Option<Unsubscribe>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MessageView {
    Folder {
        #[serde(rename = "folderId")]
        folder_id: String,
    },
    Unified {
        #[serde(rename = "wellKnown")]
        well_known: String,
    },
    Flagged,
    Category { category: String },
    Search { query: String },
    Snoozed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageQuery {
    pub view: MessageView,
    pub account_id: Option<String>,
    #[serde(default)]
    pub unread_only: bool,
    pub limit: i64,
    pub before: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub account_id: String,
    pub mode: String,
    pub ref_message_id: Option<String>,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub bcc: Vec<Addr>,
    pub subject: String,
    pub body_html: String,
    /// Deliver later: UTC ISO ("…Z"). Exchange holds the message in the Outbox until then (works with Tern closed).
    #[serde(default)]
    pub send_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Contact {
    pub name: String,
    pub email: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub name: String,
    pub mode: String,
    pub colors: HashMap<String, String>,
    pub font_family: Option<String>,
    pub mono_family: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub addr: Addr,
    #[serde(rename = "type")]
    pub kind: String,
    pub response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub id: String,
    pub account_id: String,
    pub subject: String,
    /// Local wall-clock "YYYY-MM-DDTHH:MM:SS" in `time_zone`.
    pub start: String,
    pub end: String,
    pub time_zone: String,
    pub is_all_day: bool,
    pub is_cancelled: bool,
    pub location: Option<String>,
    pub organizer: Option<Addr>,
    pub attendees: Vec<Attendee>,
    pub response: String,
    pub show_as: String,
    pub is_online: bool,
    pub join_url: Option<String>,
    pub web_link: Option<String>,
    pub preview: String,
    pub series_master_id: Option<String>,
    pub response_requested: bool,
    /// Graph calendar id this event lives in ("" when unknown / legacy rows).
    #[serde(default)]
    pub calendar_id: String,
    /// singleInstance | occurrence | exception | seriesMaster
    #[serde(default = "default_event_type")]
    pub event_type: String,
    /// Minutes before start; None = reminder off.
    #[serde(default)]
    pub reminder_minutes: Option<i64>,
    /// normal | personal | private | confidential
    #[serde(default = "default_normal")]
    pub sensitivity: String,
    #[serde(default = "default_normal")]
    pub importance: String,
    #[serde(default)]
    pub categories: Vec<String>,
}

fn default_event_type() -> String {
    "singleInstance".into()
}
fn default_normal() -> String {
    "normal".into()
}

/// One of the user's calendars (Graph `calendar` resource).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub account_id: String,
    pub name: String,
    /// "#rrggbb" when Outlook has a colour for it.
    pub color: Option<String>,
    pub is_default: bool,
    pub can_edit: bool,
    /// Owner address for shared calendars.
    pub owner: Option<String>,
}

/// Full event as fetched on demand (body + recurrence).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFull {
    pub event: CalEvent,
    pub body_html: String,
    pub body_text: String,
    /// Graph `patternedRecurrence` of the series (also filled in for occurrences).
    pub recurrence: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteInfo {
    pub meeting_type: String,
    pub event: Option<CalEvent>,
    pub conflicts: Vec<CalEvent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub account_id: String,
    pub subject: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub is_all_day: bool,
    pub location: Option<String>,
    pub body: Option<String>,
    #[serde(default)]
    pub attendees: Vec<Addr>,
    #[serde(default)]
    pub is_online: bool,
    /// Target calendar (default calendar when None).
    #[serde(default)]
    pub calendar_id: Option<String>,
    #[serde(default)]
    pub optional_attendees: Vec<Addr>,
    /// free | tentative | busy | oof | workingElsewhere
    #[serde(default)]
    pub show_as: Option<String>,
    /// Minutes before start; negative = no reminder; None = Outlook default.
    #[serde(default)]
    pub reminder_minutes: Option<i64>,
    /// normal | private
    #[serde(default)]
    pub sensitivity: Option<String>,
    /// Graph `patternedRecurrence` JSON built by the frontend.
    #[serde(default)]
    pub recurrence: Option<serde_json::Value>,
    #[serde(default)]
    pub categories: Vec<String>,
}

/// Partial update. Absent = leave alone; `null` clears where that makes sense (location, body, recurrence, reminder).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPatch {
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub is_all_day: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub location: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub body: Option<Option<String>>,
    #[serde(default)]
    pub attendees: Option<Vec<Addr>>,
    #[serde(default)]
    pub optional_attendees: Option<Vec<Addr>>,
    #[serde(default)]
    pub is_online: Option<bool>,
    #[serde(default)]
    pub show_as: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub reminder_minutes: Option<Option<i64>>,
    #[serde(default)]
    pub sensitivity: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub recurrence: Option<Option<serde_json::Value>>,
    #[serde(default)]
    pub categories: Option<Vec<String>>,
}

/// Distinguishes a missing key (None) from an explicit `null` (Some(None)).
fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeSlotQuery {
    pub account_id: String,
    #[serde(default)]
    pub attendees: Vec<String>,
    pub from: String,
    pub to: String,
    pub duration_mins: i64,
    pub work_start: Option<String>,
    pub work_end: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FreeSlot {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub accounts: Vec<Account>,
    pub settings: serde_json::Value,
    pub theme: Theme,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusEvent {
    pub account_id: String,
    pub state: String,
    pub message: Option<String>,
    pub last_sync: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailChangedEvent {
    pub account_id: String,
    pub folder_ids: Vec<String>,
    pub new_message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthProgressEvent {
    pub state: String,
    pub message: Option<String>,
}
