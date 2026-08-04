//! Minimal local file IO commands (deliverable artifacts such as HTML prototypes).
//!
//! The platform is a pure desktop client: generated artifacts are persisted
//! under the app data directory. These commands avoid pulling in the full
//! tauri-plugin-fs permission surface for two simple operations.

use std::path::Path;

/// Write UTF-8 text to `path`, creating parent directories as needed.
#[tauri::command]
pub fn fs_write_file(path: String, contents: String) -> Result<(), String> {
    let target = Path::new(&path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(target, contents).map_err(|e| format!("写入文件失败：{e}"))
}

/// Read UTF-8 text from `path` (error when missing — callers treat as "not generated yet").
#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(Path::new(&path)).map_err(|e| format!("读取文件失败：{e}"))
}
