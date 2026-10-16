// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|a| matches!(a.as_str(), "--mcp" | "--api" | "--help" | "--version"))
    {
        if let Err(e) = tern_lib::run_automation(&args) {
            eprintln!("Tern: {e:#}");
            std::process::exit(1);
        }
    } else if let tern_lib::NoteCli::Text(text) = tern_lib::parse_note_cli(&args) {
        if let Err(e) = tern_lib::capture_note_cli(&text) {
            eprintln!("Tern: {e:#}");
            std::process::exit(1);
        }
    } else {
        tern_lib::run()
    }
}
