use crate::db::Db;
use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::time::Instant;
use tokio::sync::{oneshot, Notify};

pub struct AppState {
    pub db: Db,
    pub http: reqwest::Client,
    pub settings: RwLock<serde_json::Value>,
    /// account id -> (access token, expiry)
    pub tokens: Mutex<HashMap<String, (String, Instant)>>,
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub auth_cancel: Mutex<Option<oneshot::Sender<()>>>,
    pub sync_kick: Notify,
    /// mailto: URL passed on the command line at launch, consumed once by the UI.
    pub pending_mailto: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("Tern/", env!("CARGO_PKG_VERSION")))
            .gzip(true)
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("http client");
        AppState {
            db,
            http,
            settings: RwLock::new(crate::settings::load()),
            tokens: Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
            auth_cancel: Mutex::new(None),
            sync_kick: Notify::new(),
            pending_mailto: Mutex::new(None),
        }
    }
}
