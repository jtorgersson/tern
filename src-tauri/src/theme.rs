//! Reads the active Omarchy theme and watches for theme switches.
use crate::model::Theme;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

fn theme_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    // Omarchy 3.x keeps the live theme in ~/.local/state; older versions in ~/.config.
    let candidates = [
        home.join(".local/state/omarchy/current/theme"),
        home.join(".config/omarchy/current/theme"),
    ];
    candidates.iter().find(|p| p.join("colors.toml").exists()).cloned().unwrap_or_else(|| candidates[0].clone())
}

fn theme_name_file() -> PathBuf {
    theme_dir().parent().map(|p| p.join("theme.name")).unwrap_or_default()
}

/// A Tokyo-Night-ish fallback when no Omarchy theme is present.
fn fallback() -> HashMap<String, String> {
    [
        ("background", "#1a1b26"), ("foreground", "#c0caf5"), ("accent", "#7aa2f7"),
        ("selection", "#33467c"), ("muted", "#565f89"), ("red", "#f7768e"), ("green", "#9ece6a"),
        ("yellow", "#e0af68"), ("blue", "#7aa2f7"), ("magenta", "#bb9af7"), ("cyan", "#7dcfff"),
        ("orange", "#ff9e64"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

pub fn load() -> Theme {
    let dir = theme_dir();
    let name = std::fs::read_to_string(theme_name_file()).map(|s| s.trim().to_string()).unwrap_or_else(|_| "default".into());
    let mut colors = HashMap::new();
    let mut mode = "dark".to_string();
    if let Ok(text) = std::fs::read_to_string(dir.join("colors.toml")) {
        if let Ok(table) = text.parse::<toml::Table>() {
            for (k, v) in table {
                match (k.as_str(), v) {
                    ("mode", toml::Value::String(m)) => mode = m,
                    (_, toml::Value::String(s)) if s.starts_with('#') => {
                        colors.insert(k, s);
                    }
                    _ => {}
                }
            }
        }
    }
    if colors.is_empty() {
        colors = fallback();
    }
    if dir.join("light.mode").exists() {
        mode = "light".into();
    }
    Theme { name, mode, colors, font_family: font_family(), mono_family: mono_family() }
}

fn font_family() -> Option<String> {
    // Omarchy's terminal font is the user's chosen mono; UI font we leave to CSS.
    None
}

fn mono_family() -> Option<String> {
    let home = dirs::home_dir()?;
    let text = std::fs::read_to_string(home.join(".config/alacritty/alacritty.toml")).ok()?;
    let table = text.parse::<toml::Table>().ok()?;
    table.get("font")?.get("normal")?.get("family")?.as_str().map(String::from)
}

fn stamp() -> Option<SystemTime> {
    let a = std::fs::metadata(theme_name_file()).and_then(|m| m.modified()).ok();
    let b = std::fs::metadata(theme_dir().join("colors.toml")).and_then(|m| m.modified()).ok();
    a.max(b)
}

/// Polls cheaply for theme switches (`omarchy-theme-set` rewrites theme.name).
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last = stamp();
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let now = stamp();
            if now != last {
                last = now;
                // Give the theme switcher a moment to finish writing files.
                tokio::time::sleep(Duration::from_millis(300)).await;
                let _ = app.emit("theme://changed", load());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn loads_live_theme() {
        let t = super::load();
        assert!(t.colors.contains_key("background"), "{t:?}");
        println!("{} {} accent={:?} mono={:?}", t.name, t.mode, t.colors.get("accent"), t.mono_family);
    }
}
