// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;
use std::path::PathBuf;
use std::env;
use serde::Serialize;

// Data structure
#[derive(Serialize)]
struct AppItem {
    name: String,
    target: String,
}

#[tauri::command]
fn scan_apps() -> Result<Vec<AppItem>, String> {
    let mut apps = Vec::new();

    // Main sources to search (user / system)
    let mut paths_to_scan = Vec::new();

    if let Ok(app_data) = env::var("APPDATA") {
        paths_to_scan.push(PathBuf::from(format!(r"{}\Microsoft\Windows\Start Menu\Programs", app_data)));
    }
    if let Ok(program_data) = env::var("PROGRAMDATA") {
        paths_to_scan.push(PathBuf::from(format!(r"{}\Microsoft\Windows\Start Menu\Programs", program_data)));
    }

    // Search inside of the folder recuirsively
    fn visit_dirs(dir: &PathBuf, apps: &mut Vec<AppItem>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() { // Find folder => go deeper
                    visit_dirs(&path, apps); 
                } else if path.extension().and_then(|s| s.to_str()) == Some("lnk") {
                    // Find .lnk => add to list
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        apps.push(AppItem {
                            name: name.to_string(), 
                            target: path.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }
    }

    // Scan paths
    for path in paths_to_scan {
        visit_dirs(&path, &mut apps);
    }

    Ok(apps)
}

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
        .invoke_handler(tauri::generate_handler![open_target, load_config, scan_apps])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
