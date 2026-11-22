use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Resolve ~ to the user's home directory.
fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// Project root (the macro-controller directory, one level above app/).
fn project_root() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    // During development, the exe is deep inside target/; walk up to find app/src-tauri.
    // In production, project_root is stored in a sidecar config.
    // Fallback: use an env var or a well-known path.
    if let Ok(root) = std::env::var("MACROPAD_PROJECT_ROOT") {
        return PathBuf::from(root);
    }
    // Walk up from the exe looking for config/macropad.jsonc
    let mut dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    for _ in 0..10 {
        if dir.join("config/macropad.jsonc").exists() {
            return dir;
        }
        if !dir.pop() {
            break;
        }
    }
    // Final fallback
    expand_home("~/Documents/WebProjects/macro-controller")
}

#[derive(Serialize, Clone)]
pub struct FileChanged {
    pub path: String,
    pub kind: String,
}

// ---- Tauri commands ----

#[tauri::command]
pub fn get_project_root() -> String {
    project_root().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let p = expand_home(&path);
    fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

#[tauri::command]
pub fn write_file(path: String, content: String, backup: bool) -> Result<(), String> {
    let p = expand_home(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    // Backup existing file
    if backup && p.exists() {
        let bak = p.with_extension(format!(
            "{}.bak",
            p.extension().unwrap_or_default().to_string_lossy()
        ));
        let _ = fs::copy(&p, &bak);
    }
    // Atomic write: write to a temp file then rename
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, &content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename {}: {e}", p.display()))?;
    Ok(())
}

#[tauri::command]
pub fn list_files(dir: String, ext: String) -> Result<Vec<String>, String> {
    let d = expand_home(&dir);
    if !d.exists() {
        return Ok(vec![]);
    }
    let mut result = Vec::new();
    let entries = fs::read_dir(&d).map_err(|e| format!("readdir {}: {e}", d.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if ext.is_empty() || name.ends_with(&ext) {
            result.push(name);
        }
    }
    result.sort();
    Ok(result)
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = expand_home(&path);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("delete {}: {e}", p.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn read_cursor_keybindings() -> Result<String, String> {
    let p = dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Application Support/Cursor/User/keybindings.json");
    fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

#[tauri::command]
pub fn write_cursor_keybindings(content: String) -> Result<(), String> {
    let p = dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Application Support/Cursor/User/keybindings.json");
    // Always backup before writing
    if p.exists() {
        let bak = p.with_extension("json.bak");
        let _ = fs::copy(&p, &bak);
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename {}: {e}", p.display()))?;
    Ok(())
}

/// Ping the Hammerspoon bridge. The Tauri webview can't reach localhost directly
/// due to CSP, so we do it from Rust.
#[tauri::command]
pub fn check_bridge(port: u16, token: String) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("127.0.0.1:{port}");
    let mut stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("bad addr: {e}"))?,
        Duration::from_secs(2),
    )
    .map_err(|e| format!("connect: {e}"))?;

    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let request = format!(
        "POST /ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Macropad-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("read: {e}"))?;

    // Parse the status line: "HTTP/1.1 200 OK\r\n..."
    let status_line = response.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if status_code == 200 {
        Ok(format!("ok (port {port})"))
    } else {
        Err(format!("responded {status_code}"))
    }
}

/// Check if the macropad extension is installed in Cursor's extensions directory.
#[tauri::command]
pub fn check_extension_installed() -> Result<String, String> {
    let ext_dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".cursor/extensions");

    if !ext_dir.exists() {
        return Err("extensions directory not found".into());
    }

    let mut versions: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&ext_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("jack-local.macropad-") || name.starts_with("macropad-") {
                versions.push(name);
            }
        }
    }

    if versions.is_empty() {
        return Err("not installed".into());
    }

    versions.sort();
    Ok(versions.last().unwrap().clone())
}

// ---- File watcher (runs in background, emits events to the frontend) ----

pub fn start_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        use notify::{Event, RecursiveMode, Watcher};

        let root = project_root();
        let macropad_dir = expand_home("~/.macropad");

        let app_handle = app.clone();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                for path in &event.paths {
                    let path_str = path.to_string_lossy().into_owned();
                    let kind = format!("{:?}", event.kind);
                    let _ = app_handle.emit(
                        "file-changed",
                        FileChanged {
                            path: path_str,
                            kind,
                        },
                    );
                }
            }
        })
        .expect("failed to create file watcher");

        // The kqueue backend only reports in-place writes for files it watches
        // individually; Recursive mode adds a watch per file in each directory.
        let _ = watcher.watch(&root.join("config"), RecursiveMode::Recursive);
        let prompts_dir = root.join("prompts");
        if prompts_dir.exists() {
            let _ = watcher.watch(&prompts_dir, RecursiveMode::Recursive);
        }
        // Watch ~/.macropad for last-input.json and commands.json
        let _ = fs::create_dir_all(&macropad_dir);
        let _ = watcher.watch(&macropad_dir, RecursiveMode::Recursive);

        // Keep thread alive
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}
