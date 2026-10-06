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
