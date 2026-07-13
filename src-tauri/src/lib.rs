// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::env;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowTextLengthW, 
    IsWindowVisible, SetForegroundWindow, ShowWindow,
    SW_RESTORE, IsIconic
};

// Data structure
#[derive(Serialize, Deserialize, Clone)]
struct AppItem {
    name: String,
    target: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Config {
    custom_apps: Vec<AppItem>,
}

unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL{
    // 見えないウィンドウ（バックグラウンドプロセスなど）を除外
    if IsWindowVisible(hwnd).as_bool() {
        let length = GetWindowTextLengthW(hwnd);
        if length > 0 {
            let mut buffer = vec![0u16; (length + 1) as usize];
            GetWindowTextW(hwnd, &mut buffer);
            let title = String::from_utf16_lossy(&buffer).trim_end_matches('\0').to_string();
            
            // 余計なシステムウィンドウを除外
            if !title.is_empty() && title != "Program Manager" {
                let windows = &mut *(lparam.0 as *mut Vec<AppItem>);
                windows.push(AppItem {
                    name: format!("🪟 {}", title), // 識別しやすいように窓アイコンをつける
                    target: format!("HWND:{}", hwnd.0 as usize), // ハンドル（ID）を保存
                    description: None,
                });
            }
        }
    }
    true.into()
}

#[tauri::command]
fn get_open_windows() -> Result<Vec<AppItem>, String> {
    let mut windows: Vec<AppItem> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_window_proc), LPARAM(&mut windows as *mut _ as isize));
    }
    Ok(windows)
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
                            description: None,
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
    use std::os::windows::process::CommandExt;
    if target.starts_with("HWND:"){
     let hwnd_str = &target[5..];
     if let Ok(hwnd_val) = hwnd_str.parse::<usize>() {
        unsafe {
            let hwnd = HWND(hwnd_val as isize);
            if IsIconic(hwnd).as_bool() {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
        return Ok(format!("Switched to window: {}", hwnd_str));
     }   
    }

    // Launch apps by powerShell in windows
    let ps_command = format!(
        "try {{ Start-Process '{}' -WindowStyle Maximized -ErrorAction Stop }} catch {{ exit 1 }}",
        target
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_command])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW（黒い画面を出さない）
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(format!("Opened max: {}", target))
    } else {
        Err(format!("Failed to open: {}", target))
    }
}

#[tauri::command]
fn save_command(name: String, target: String, description: Option<String>) -> Result<(), String> {
    let config_path = "config.json";

    // 現在のconfig.jsonを読み込むか、なければ空の初期構造を作る
    let mut config: Config = match fs::read_to_string(config_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(Config { custom_apps: vec![] }),
        Err(_) => Config { custom_apps: vec![] }, // ファイルがない場合は新規作成
    };

    // 新しいコマンドをリストに追加
    config.custom_apps.push(AppItem {
        name,
        target,
        description,
    });

    // 整形されたJSON文字列に変換してファイルに書き込む
    let new_content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, new_content).map_err(|e| e.to_string())?;

    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_target, load_config, scan_apps, get_open_windows, save_command])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
