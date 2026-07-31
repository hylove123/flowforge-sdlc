// ================================================================
//  Phase 6 体验打磨 — system notifications + tray icon
//
//  notify_user(title, body)  frontend-driven system notification;
//  the JS side listens for sidecar events (graph/completed,
//  graph/interrupted, delegate://received) and calls this command,
//  keeping Rust decoupled from sidecar event semantics.
//
//  setup_tray() installs a tray icon with 显示/隐藏/退出 menu items;
//  left-clicking the icon brings the main window back.
// ================================================================

use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager, Runtime,
};
use tauri_plugin_notification::NotificationExt;

/// Sends a system notification (frontend bridges sidecar events here).
#[tauri::command]
pub fn notify_user<R: Runtime>(app: AppHandle<R>, title: String, body: String) -> Result<(), String> {
  app
    .notification()
    .builder()
    .title(title)
    .body(body)
    .show()
    .map_err(|e| e.to_string())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

/// Installs the tray icon + menu. Called once from lib.rs setup().
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
  let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
  let hide = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "退出 FlowForge", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

  let mut tray = TrayIconBuilder::with_id("flowforge-tray")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .tooltip("FlowForge SDLC")
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show" => show_main_window(app),
      "hide" => {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.hide();
        }
      }
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      // left click restores the window; right click opens the menu
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        show_main_window(tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(icon.clone());
  }

  tray.build(app)?;
  Ok(())
}
