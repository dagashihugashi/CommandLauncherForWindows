// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;

#[tauri::command]
fn load_config() -> Result<String, String> {
    // Load src-tauri/config.json (Dev mode)
    match fs::read_to_string("config.json") {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Load failed: {}", e)),
    }
}

#[tauri::command]
fn open_target(target : &str) -> Result<String, String> {
    use std::process::Command;

    // Launch apps by "cmd /c start" in windows
    let output = Command::new("cmd")
        .args(["/c", "start", "", target])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(format!("Opened: {}", target))
    } else {
        Err(format!("Failed to open: {}", target))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_target, load_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
