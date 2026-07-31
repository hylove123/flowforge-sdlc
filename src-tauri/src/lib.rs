pub mod commands;

use std::sync::Arc;

use commands::{code_index, git_ops, notify, sidecar, storage, tool_bridge};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let sidecar_manager = Arc::new(sidecar::SidecarManager::default());

  let app = tauri::Builder::default()
    .manage(Arc::clone(&sidecar_manager))
    .manage(tool_bridge::DelegateState::default())
    .manage(git_ops::CodeWatchState::default())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_dialog::init())
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // SQLite at {app_data_dir}/.flowforge/flowforge.db — the plugin is
      // registered here (not on the builder) because the migration key is
      // the absolute db URL, which needs a resolved app handle.
      let db_url = storage::db_url(app.handle()).map_err(std::io::Error::other)?;
      app.handle().plugin(
        tauri_plugin_sql::Builder::default()
          .add_migrations(&db_url, storage::migrations())
          .build(),
      )?;

      // launch + supervise the Node sidecar
      sidecar::spawn_supervisor(app.handle().clone(), Arc::clone(&sidecar_manager));

      // Phase 6: tray icon (显示/隐藏/退出)
      notify::setup_tray(app.handle())?;

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      sidecar::sidecar_request,
      sidecar::sidecar_status,
      storage::storage_db_path,
      storage::storage_pragmas,
      tool_bridge::delegate_dispatch,
      tool_bridge::delegate_cancel,
      code_index::code_index_full,
      code_index::code_index_query,
      code_index::code_index_stats,
      git_ops::git_status,
      git_ops::git_recent_commits,
      git_ops::git_changed_files,
      git_ops::git_clone,
      git_ops::git_create_branch,
      git_ops::git_checkout_branch,
      git_ops::git_branch_list,
      git_ops::git_push,
      git_ops::git_check_available,
      git_ops::validate_local_repo,
      git_ops::code_index_incremental,
      git_ops::code_index_watch,
      git_ops::code_index_unwatch,
      notify::notify_user,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(move |app_handle, event| {
    if let tauri::RunEvent::ExitRequested { .. } = event {
      // stop the supervisor loop and close the sidecar's stdin;
      // kill_on_drop reaps the child process itself
      let manager = app_handle.state::<Arc<sidecar::SidecarManager>>();
      sidecar::shutdown(&manager);
    }
  });
}
