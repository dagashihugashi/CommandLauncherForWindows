// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{ComInterface, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC,
    SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::{
    IShellLinkW, ShellExecuteW, ShellLink, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
    SHGetFileInfoW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GetClassLongPtrW, GetIconInfo, GetWindowTextLengthW,
    GetWindowTextW, IsIconic, IsWindowVisible, SendMessageTimeoutW, SetForegroundWindow,
    ShowWindow, GCLP_HICON, HICON, ICONINFO, ICON_BIG, SMTO_ABORTIFHUNG, SW_RESTORE,
    SW_SHOWMAXIMIZED, WM_GETICON,
};

// Data structure
#[derive(Serialize, Deserialize, Clone)]
struct AppItem {
    name: String,
    target: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    // クエリ検索（"g react"等）のキーワードとして使えるようにするかどうか
    // フロント側はcamelCase(queryMode)前提で読むため、JSON上のキー名もそれに合わせる。
    // 過去にsnake_case(query_mode)で保存された既存のconfig.jsonも壊さないようaliasで両対応にする
    #[serde(default, rename = "queryMode", alias = "query_mode")]
    query_mode: bool,
}

// HICONの中身をピクセルデータとして読み出し、PNGのdata URIに変換する
// （scan_appsとget_open_windows双方から使う共通ロジック）
fn hicon_to_data_uri(hicon: HICON) -> Option<String> {
    if hicon.0 == 0 {
        return None;
    }
    unsafe {
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            return None;
        }

        let mut bmp = BITMAP::default();
        let ok = GetObjectW(
            HGDIOBJ(icon_info.hbmColor.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        );

        let width = bmp.bmWidth;
        let height = bmp.bmHeight;

        let png = if ok != 0 && width > 0 && height > 0 {
            let mut buffer = vec![0u8; (width * height * 4) as usize];
            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // 上下反転させず取得する
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0 as u32,
                    ..Default::default()
                },
                ..Default::default()
            };

            let hdc_screen = GetDC(HWND(0));
            let hdc_mem = CreateCompatibleDC(hdc_screen);
            let old_obj = SelectObject(hdc_mem, HGDIOBJ(icon_info.hbmColor.0));

            let lines = GetDIBits(
                hdc_mem,
                icon_info.hbmColor,
                0,
                height as u32,
                Some(buffer.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            SelectObject(hdc_mem, old_obj);
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(HWND(0), hdc_screen);

            if lines == 0 {
                None
            } else {
                // BGRA -> RGBA
                for px in buffer.chunks_exact_mut(4) {
                    px.swap(0, 2);
                }
                image::RgbaImage::from_raw(width as u32, height as u32, buffer).and_then(|img| {
                    let mut png_bytes: Vec<u8> = Vec::new();
                    image::DynamicImage::ImageRgba8(img)
                        .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
                        .ok()?;
                    Some(png_bytes)
                })
            }
        } else {
            None
        };

        let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));

        png.map(|bytes| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            )
        })
    }
}

// ファイルパス（.lnkやexe）が持つアイコンを取得する
// .lnkショートカットを解決して、リンク先の実体パスを取得する
// （.lnkのまま渡すと、Windowsのシェルがショートカット矢印バッジを合成したアイコンを返してしまうため）
fn resolve_lnk_target(lnk_path: &str) -> Option<String> {
    unsafe {
        let com_init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // ?による早期returnをクロージャ内に閉じ込め、CoUninitializeを必ず通す
        let result = (|| -> Option<String> {
            let shell_link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let persist_file: IPersistFile = shell_link.cast().ok()?;

            let wide: Vec<u16> = OsStr::new(lnk_path).encode_wide().chain(std::iter::once(0)).collect();
            persist_file.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;

            let mut buffer = [0u16; 260]; // MAX_PATH
            shell_link.GetPath(&mut buffer, std::ptr::null_mut(), 0).ok()?;

            let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            if end == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buffer[..end]))
        })();

        if com_init.is_ok() {
            CoUninitialize();
        }

        result
    }
}

fn icon_from_path(path: &str) -> Option<String> {
    // .lnkはリンク先の実体パスに解決してからアイコンを取る（解決できなければ.lnk自体にフォールバック）
    let resolved = if path.to_lowercase().ends_with(".lnk") {
        resolve_lnk_target(path).unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };

    unsafe {
        let wide: Vec<u16> = OsStr::new(&resolved).encode_wide().chain(std::iter::once(0)).collect();
        let mut shfi = SHFILEINFOW::default();
        let res = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if res == 0 || shfi.hIcon.0 == 0 {
            return None;
        }
        let data_uri = hicon_to_data_uri(shfi.hIcon);
        let _ = DestroyIcon(shfi.hIcon);
        data_uri
    }
}

// ウィンドウハンドルが持つアイコン（タスクバーに出ているものと同じ）を取得する
fn icon_from_hwnd(hwnd: HWND) -> Option<String> {
    unsafe {
        // 相手のウィンドウが応答なし(ハング中)でも待ち続けないよう、
        // SendMessageWではなくタイムアウト付きのSendMessageTimeoutWを使う
        let mut result: usize = 0;
        let replied = SendMessageTimeoutW(
            hwnd,
            WM_GETICON,
            WPARAM(ICON_BIG as usize),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            200, // ms
            Some(&mut result),
        )
        .0 != 0;

        let mut hicon = if replied { result as isize } else { 0 };
        if hicon == 0 {
            hicon = GetClassLongPtrW(hwnd, GCLP_HICON) as isize;
        }
        if hicon == 0 {
            return None;
        }
        // ウィンドウ/クラスが所有するアイコンなのでDestroyIconはしない
        hicon_to_data_uri(HICON(hicon))
    }
}

// コマンド関連(config.json)。設定(settings.json)とは別ファイルにして、
// 登録コマンドが増えても設定側のファイルは肥大化しないようにする
#[derive(Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    custom_apps: Vec<AppItem>,
    // targetをキーに、起動回数と最終起動時刻(unix秒)を記録する（フリーセンシーによる並び替え用）
    #[serde(default)]
    usage: HashMap<String, UsageEntry>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct UsageEntry {
    count: u32,
    last_used: u64,
}

// /settings で編集できるユーザー設定
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default = "default_background_color")]
    background_color: String,
    #[serde(default = "default_opacity")]
    opacity: f64,
    #[serde(default = "default_text_color")]
    text_color: String,
    // ラベル/プロンプト側（[WindowsManeuver]>やName:等）の文字色。text_colorとは別に変更できる
    #[serde(default = "default_label_color")]
    label_color: String,
    // 検索候補を選択した時のハイライト（左端のラインと文字色）
    #[serde(default = "default_highlight_color")]
    highlight_color: String,
    #[serde(default = "default_alert_color")]
    alert_color: String,
    #[serde(default = "default_success_color")]
    success_color: String,
    #[serde(default = "default_error_color")]
    error_color: String,
    #[serde(default = "default_hotkey")]
    hotkey: String,
}

fn default_background_color() -> String {
    "#000000".to_string()
}
fn default_opacity() -> f64 {
    0.95
}
fn default_text_color() -> String {
    "#dddddd".to_string()
}
fn default_label_color() -> String {
    "#777777".to_string()
}
fn default_highlight_color() -> String {
    "#ffffff".to_string()
}
fn default_alert_color() -> String {
    "#ff5c5c".to_string()
}
fn default_success_color() -> String {
    "#06bc5e".to_string()
}
fn default_error_color() -> String {
    "#ca4444".to_string()
}
fn default_hotkey() -> String {
    "Alt+Space".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            background_color: default_background_color(),
            opacity: default_opacity(),
            text_color: default_text_color(),
            label_color: default_label_color(),
            highlight_color: default_highlight_color(),
            alert_color: default_alert_color(),
            success_color: default_success_color(),
            error_color: default_error_color(),
            hotkey: default_hotkey(),
        }
    }
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
                    icon: None, // アイコンは画面に表示された分だけget_iconで遅延取得する
                    query_mode: false,
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

// 画面に実際に表示されているアイテムの分だけ、フロントから呼ばれてアイコンを取得する
#[tauri::command]
fn get_icon(target: String) -> Option<String> {
    if let Some(hwnd_str) = target.strip_prefix("HWND:") {
        let hwnd_val: isize = hwnd_str.parse().ok()?;
        return icon_from_hwnd(HWND(hwnd_val));
    }
    if target.starts_with("http") || target == "cmd:add" {
        return None;
    }
    icon_from_path(&target)
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
                            icon: None, // アイコンは画面に表示された分だけget_iconで遅延取得する
                            query_mode: false,
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

// exeと同じディレクトリのconfig.jsonを指す（devビルドでもリリースビルドでも同じロジックで解決する）
fn get_config_path() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to resolve exe directory".to_string())?;
    Ok(exe_dir.join("config.json"))
}

// exeと同じディレクトリのsettings.jsonを指す
fn get_settings_path() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to resolve exe directory".to_string())?;
    Ok(exe_dir.join("settings.json"))
}

#[tauri::command]
fn load_config() -> Result<String, String> {
    let config_path = get_config_path()?;
    let raw = fs::read_to_string(&config_path).map_err(|e| format!("Load failed: {}", e))?;

    // Config構造体を経由して返すことで、rename/aliasによるキー名の正規化
    // （例: 過去のquery_mode -> queryMode）をフロントに渡す前に適用する
    let config: Config = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    serde_json::to_string(&config).map_err(|e| e.to_string())
}

// 起動したアイテムの利用回数・最終利用時刻を記録する（検索結果のフリーセンシー並び替え用）
#[tauri::command]
fn record_usage(target: String) -> Result<(), String> {
    let config_path = get_config_path()?;

    let mut config: Config = match fs::read_to_string(&config_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Config::default(),
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let entry = config.usage.entry(target).or_default();
    entry.count += 1;
    entry.last_used = now;

    let new_content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_path, new_content).map_err(|e| e.to_string())?;

    Ok(())
}

// settings.jsonを読む。無ければ、まだ移行前の旧config.json内のsettingsキーが
// 残っていないか確認し、見つかればそれをsettings.jsonへ書き出してから返す
#[tauri::command]
fn load_settings() -> Result<String, String> {
    let settings_path = get_settings_path()?;

    if let Ok(raw) = fs::read_to_string(&settings_path) {
        let settings: AppSettings = serde_json::from_str(&raw).unwrap_or_default();
        return serde_json::to_string(&settings).map_err(|e| e.to_string());
    }

    // settings.jsonがまだ無い場合、旧バージョンで config.json 内に同居していた
    // settingsキーからの移行を試みる（無ければ既定値にフォールバック）
    if let Ok(config_path) = get_config_path() {
        if let Ok(raw) = fs::read_to_string(&config_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(legacy) = value.get("settings") {
                    if let Ok(settings) = serde_json::from_value::<AppSettings>(legacy.clone()) {
                        if let Ok(pretty) = serde_json::to_string_pretty(&settings) {
                            let _ = fs::write(&settings_path, pretty);
                        }
                        return serde_json::to_string(&settings).map_err(|e| e.to_string());
                    }
                }
            }
        }
    }

    serde_json::to_string(&AppSettings::default()).map_err(|e| e.to_string())
}

// /settings で編集した内容をsettings.jsonへ保存する
#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<(), String> {
    let settings_path = get_settings_path()?;
    let new_content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&settings_path, new_content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_target(target: &str) -> Result<String, String> {
    if target.starts_with("HWND:") {
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

    // アプリ/URLをシェル経由で直接開く。
    // 以前はpowershell.exeを毎回新規起動してStart-Processしていたが、
    // プロセス起動オーバーヘッドだけで実測300ms前後かかり体感の遅さの主因だったため、
    // 同じプロセス内からWin32のShellExecuteWを直接呼ぶ方式にして高速化する
    unsafe {
        let com_init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let target_wide: Vec<u16> = OsStr::new(target).encode_wide().chain(std::iter::once(0)).collect();
        let operation_wide: Vec<u16> = OsStr::new("open").encode_wide().chain(std::iter::once(0)).collect();

        let result = ShellExecuteW(
            HWND(0),
            PCWSTR(operation_wide.as_ptr()),
            PCWSTR(target_wide.as_ptr()),
            PCWSTR(std::ptr::null()),
            PCWSTR(std::ptr::null()),
            SW_SHOWMAXIMIZED,
        );

        if com_init.is_ok() {
            CoUninitialize();
        }

        // ShellExecuteWの戻り値は成功時32より大きい値、失敗時は32以下のエラーコード
        if (result.0 as usize) > 32 {
            Ok(format!("Opened: {}", target))
        } else {
            Err(format!("Failed to open (error code {}): {}", result.0 as usize, target))
        }
    }
}

// sleep/lock/shutdown/restart のシステムコマンド。shutdown/restartはフロント側でy/n確認を
// 経由してから呼ばれる想定（ここでは受け取ったら即実行する）
#[tauri::command]
fn run_system_command(action: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let spawn_result = match action {
        "sleep" => Command::new("rundll32.exe")
            .args(["powrprof.dll,SetSuspendState", "0,1,0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        "lock" => Command::new("rundll32.exe")
            .args(["user32.dll,LockWorkStation"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        "shutdown" => Command::new("shutdown")
            .args(["/s", "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        "restart" => Command::new("shutdown")
            .args(["/r", "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        "hibernate" => Command::new("shutdown")
            .args(["/h"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        "logoff" => Command::new("shutdown")
            .args(["/l"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        "explorer" => Command::new("explorer.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        "emptytrash" => Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Clear-RecycleBin -Force -ErrorAction SilentlyContinue",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn(),
        _ => return Err(format!("Unknown system action: {}", action)),
    };

    spawn_result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_command(
    name: String,
    target: String,
    description: Option<String>,
    query_mode: bool,
) -> Result<(), String> {
    let config_path = get_config_path()?;

    // 現在のconfig.jsonを読み込むか、なければ空の初期構造を作る
    let mut config: Config = match fs::read_to_string(&config_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(Config::default()),
        Err(_) => Config::default(), // ファイルがない場合は新規作成
    };

    // 新しいコマンドをリストに追加
    config.custom_apps.push(AppItem {
        name,
        target,
        description,
        icon: None,
        query_mode,
    });

    // 整形されたJSON文字列に変換してファイルに書き込む
    let new_content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_path, new_content).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_command(name: String) -> Result<(), String> {
    let config_path = get_config_path()?;

    let mut config: Config = match std::fs::read_to_string(&config_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(Config::default()),
        Err(_) => return Err("設定ファイルが見つかりません".to_string()),
    };

    config.custom_apps.retain(|app| app.name != name);

    // 3. 上書き保存する
    let new_content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, new_content).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn edit_command(
    old_name: String,
    new_name: String,
    new_target: String,
    new_description: Option<String>,
    new_query_mode: bool,
) -> Result<(), String> {
    let config_path = get_config_path()?;

    // 1. 現在のデータを読み込む
    let mut config: Config = match std::fs::read_to_string(&config_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(Config::default()),
        Err(_) => return Err("設定ファイルが見つかりません".to_string()),
    };

    // 2. old_name と一致するものを探して、中身を書き換える
    if let Some(app) = config.custom_apps.iter_mut().find(|a| a.name == old_name) {
        app.name = new_name;
        app.target = new_target;
        app.description = new_description;
        app.query_mode = new_query_mode;
    } else {
        return Err("編集対象のコマンドが見つかりません".to_string());
    }

    // 3. 上書き保存する
    let new_content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, new_content).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_target,
            load_config,
            scan_apps,
            get_open_windows,
            save_command,
            delete_command,
            edit_command,
            get_icon,
            record_usage,
            run_system_command,
            load_settings,
            save_settings
            ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
