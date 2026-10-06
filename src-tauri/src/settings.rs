//! User settings, stored as JSON in ~/.config/tern/settings.json.
//! The frontend owns the shape (see `Settings` in src/lib/types.ts); Rust only
//! reads the few keys it needs and deep-merges defaults so new keys appear.
use anyhow::Result;
use serde_json::{json, Value};
use std::path::PathBuf;

pub fn path() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("tern").join("settings.json")
}

pub fn defaults() -> Value {
    json!({
        "microsoft": { "clientId": "", "tenant": "common" },
        "ai": {
            "providers": [],
            "defaultProviderId": null,
            "triageProviderId": null,
            "triageEnabled": true,
            "autoApproveSafeActions": false,
            "aboutMe": ""
        },
        "ui": {
            "density": "comfortable",
            "remoteImages": "ask",
            "mailRendering": "adaptive",
            "translucent": true
        },
        "signatures": {},
        "syncIntervalSecs": 60
    })
}

fn merge(base: &mut Value, over: &Value) {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in o {
                match b.get_mut(k) {
                    Some(bv) if bv.is_object() && v.is_object() => merge(bv, v),
                    _ => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, o) => *b = o.clone(),
    }
}

pub fn load() -> Value {
    let mut s = defaults();
    if let Ok(text) = std::fs::read_to_string(path()) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            merge(&mut s, &v);
        }
    }
    s
}

pub fn save(v: &Value) -> Result<Value> {
    let mut s = defaults();
    merge(&mut s, v);
    let p = path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&s)?)?;
    std::fs::rename(tmp, &p)?;
    Ok(s)
}

pub fn ms_client_id(s: &Value) -> String {
    s.pointer("/microsoft/clientId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

pub fn ms_tenant(s: &Value) -> String {
    let t = s.pointer("/microsoft/tenant").and_then(|v| v.as_str()).unwrap_or("").trim();
    if t.is_empty() { "common".into() } else { t.into() }
}

pub fn sync_interval(s: &Value) -> u64 {
    s.get("syncIntervalSecs").and_then(|v| v.as_u64()).unwrap_or(60).clamp(15, 3600)
}
