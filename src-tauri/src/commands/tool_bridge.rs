// ================================================================
//  Tool Bridge — delegate dispatch & file-watch recycle (Phase 4)
//
//  delegate_dispatch(payload):
//    1. writes the context package to the system clipboard
//    2. optionally opens an external tool via URI scheme (cursor://, vscode://…)
//    3. starts a notify watcher on the recycle dir; new/changed files are
//       debounced (2s) and pushed to the frontend as `delegate://received`
//    4. a configurable timeout (default 30min) emits `delegate://timeout`
//
//  delegate_cancel(delegationId): stops the watcher for that delegation.
//
//  The watch loop is decoupled from AppHandle (it takes an emitter closure)
//  so the debounce/timeout behaviour is verifiable with plain `cargo test`.
// ================================================================

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const DEFAULT_TIMEOUT_MS: u64 = 30 * 60 * 1000; // 30 min
const DEFAULT_DEBOUNCE_MS: u64 = 2_000; // 2 s
const POLL_INTERVAL_MS: u64 = 200;
const MAX_PREVIEW_BYTES: u64 = 512 * 1024; // cap file previews at 512KB

/// delegationId → cancel flag for the running watcher thread.
#[derive(Default)]
pub struct DelegateState(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchPayload {
  /// Context package markdown copied to the clipboard for the external tool.
  pub context: String,
  /// Optional URI scheme to launch (e.g. "cursor://", "vscode://", "qoderwork://…").
  pub target_uri: Option<String>,
  /// Caller-supplied id (a fresh one is generated when absent).
  pub delegation_id: Option<String>,
  /// Recycle dir override; defaults to {app_data_dir}/.flowforge/delegate/{id}/.
  pub watch_dir: Option<String>,
  /// Test seam: shorten the 30min timeout / 2s debounce.
  pub timeout_ms: Option<u64>,
  pub debounce_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
  pub delegation_id: String,
  pub watch_dir: String,
  pub clipboard: bool,
  pub opened: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedFile {
  pub path: String,
  pub name: String,
  /// UTF-8 preview of the file (present when readable and under the size cap).
  pub content: Option<String>,
}

fn new_delegation_id() -> String {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default();
  format!("dg_{}_{:06}", now.as_millis(), now.subsec_nanos() % 1_000_000)
}

fn read_preview(path: &Path) -> Option<String> {
  let meta = std::fs::metadata(path).ok()?;
  if !meta.is_file() || meta.len() > MAX_PREVIEW_BYTES {
    return None;
  }
  std::fs::read_to_string(path).ok()
}

// ─── Watch loop (AppHandle-free, cargo-testable) ─────────────────

/// Watches `dir` until either (a) file activity settles for `debounce`,
/// then emits `delegate://received` with the touched files, or (b) `timeout`
/// elapses → `delegate://timeout`, or (c) the cancel flag is raised.
pub fn watch_delegate_dir<F>(
  dir: PathBuf,
  delegation_id: String,
  cancel: Arc<AtomicBool>,
  timeout: Duration,
  debounce: Duration,
  emit: F,
) where
  F: Fn(&str, serde_json::Value),
{
  let (tx, rx) = channel::<notify::Result<notify::Event>>();
  let mut watcher = match notify::recommended_watcher(move |res| {
    let _ = tx.send(res);
  }) {
    Ok(w) => w,
    Err(e) => {
      emit(
        "delegate://error",
        serde_json::json!({ "delegationId": delegation_id, "message": e.to_string() }),
      );
      return;
    }
  };
  if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
    emit(
      "delegate://error",
      serde_json::json!({ "delegationId": delegation_id, "message": e.to_string() }),
    );
    return;
  }

  let started = Instant::now();
  let mut pending: HashSet<PathBuf> = HashSet::new();
  let mut last_event: Option<Instant> = None;

  loop {
    if cancel.load(Ordering::SeqCst) {
      return; // cancelled — stop silently
    }
    if started.elapsed() >= timeout {
      emit(
        "delegate://timeout",
        serde_json::json!({ "delegationId": delegation_id }),
      );
      return;
    }

    match rx.recv_timeout(Duration::from_millis(POLL_INTERVAL_MS)) {
      Ok(Ok(event)) => {
        if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
          for p in event.paths {
            if p.is_file() {
              pending.insert(p);
            }
          }
          if !pending.is_empty() {
            last_event = Some(Instant::now());
          }
        }
      }
      Ok(Err(_)) | Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => return,
    }

    // debounce: fire once activity has settled
    if let Some(at) = last_event {
      if at.elapsed() >= debounce && !pending.is_empty() {
        let files: Vec<ReceivedFile> = pending
          .iter()
          .map(|p| ReceivedFile {
            path: p.to_string_lossy().into_owned(),
            name: p
              .file_name()
              .map(|n| n.to_string_lossy().into_owned())
              .unwrap_or_default(),
            content: read_preview(p),
          })
          .collect();
        emit(
          "delegate://received",
          serde_json::json!({
            "delegationId": delegation_id,
            "watchDir": dir.to_string_lossy(),
            "files": files,
          }),
        );
        return; // one-shot: dispatch is complete after the first settled batch
      }
    }
  }
}

fn spawn_watcher(
  app: AppHandle,
  state: &DelegateState,
  delegation_id: String,
  dir: PathBuf,
  timeout: Duration,
  debounce: Duration,
) {
  let cancel = Arc::new(AtomicBool::new(false));
  state
    .0
    .lock()
    .expect("delegate state poisoned")
    .insert(delegation_id.clone(), Arc::clone(&cancel));

  std::thread::spawn(move || {
    let emitter_app = app.clone();
    let id_for_cleanup = delegation_id.clone();
    watch_delegate_dir(dir, delegation_id, cancel, timeout, debounce, move |event, payload| {
      if let Err(e) = emitter_app.emit(event, payload) {
        log::warn!("delegate emit {event} failed: {e}");
      }
    });
    // watcher finished (received / timeout / cancel) — drop the handle
    if let Some(map) = app.try_state::<DelegateState>() {
      map
        .0
        .lock()
        .expect("delegate state poisoned")
        .remove(&id_for_cleanup);
    }
  });
}

// ─── Commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn delegate_dispatch(
  app: AppHandle,
  state: State<'_, DelegateState>,
  payload: DispatchPayload,
) -> Result<DispatchResult, String> {
  let delegation_id = payload
    .delegation_id
    .filter(|s| !s.is_empty())
    .unwrap_or_else(new_delegation_id);

  // recycle dir: explicit override → {app_data_dir}/.flowforge/delegate/{id}/
  let watch_dir = match payload.watch_dir.filter(|s| !s.is_empty()) {
    Some(dir) => PathBuf::from(dir),
    None => app
      .path()
      .app_data_dir()
      .map_err(|e| e.to_string())?
      .join(".flowforge")
      .join("delegate")
      .join(&delegation_id),
  };
  std::fs::create_dir_all(&watch_dir).map_err(|e| e.to_string())?;

  // 1. context package → clipboard (external tool pastes it)
  let clipboard = match app.clipboard().write_text(payload.context.clone()) {
    Ok(()) => true,
    Err(e) => {
      log::warn!("delegate clipboard write failed: {e}");
      false
    }
  };

  // 2. optional URI scheme launch (cursor:// vscode:// qoderwork:// …)
  let mut opened = false;
  if let Some(uri) = payload.target_uri.as_deref().filter(|s| !s.is_empty()) {
    match app.opener().open_url(uri, None::<&str>) {
      Ok(()) => opened = true,
      Err(e) => log::warn!("delegate open_url {uri} failed: {e}"),
    }
  }

  // 3. watch the recycle dir until files settle / timeout / cancel
  let timeout = Duration::from_millis(payload.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
  let debounce = Duration::from_millis(payload.debounce_ms.unwrap_or(DEFAULT_DEBOUNCE_MS));
  spawn_watcher(
    app.clone(),
    &state,
    delegation_id.clone(),
    watch_dir.clone(),
    timeout,
    debounce,
  );

  Ok(DispatchResult {
    delegation_id,
    watch_dir: watch_dir.to_string_lossy().into_owned(),
    clipboard,
    opened,
  })
}

#[tauri::command]
pub fn delegate_cancel(
  state: State<'_, DelegateState>,
  delegation_id: String,
) -> Result<bool, String> {
  let mut map = state.0.lock().map_err(|_| "delegate state poisoned")?;
  match map.remove(&delegation_id) {
    Some(flag) => {
      flag.store(true, Ordering::SeqCst);
      Ok(true)
    }
    None => Ok(false),
  }
}

// ─── Tests (debounce + timeout, no Tauri runtime needed) ────────

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc::channel as std_channel;

  fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flowforge-delegate-{tag}-{}", new_delegation_id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn received_event_fires_after_debounce_when_a_file_lands() {
    let dir = temp_dir("recv");
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std_channel::<(String, serde_json::Value)>();

    let watch_dir = dir.clone();
    let handle = std::thread::spawn(move || {
      watch_delegate_dir(
        watch_dir,
        "dg_test".into(),
        cancel,
        Duration::from_secs(10),
        Duration::from_millis(500), // short debounce keeps the test fast
        move |event, payload| {
          let _ = tx.send((event.to_string(), payload));
        },
      );
    });

    // give the watcher a beat to arm, then drop the recycled deliverable
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(dir.join("result.md"), "# 外派产出\n42").unwrap();

    let (event, payload) = rx.recv_timeout(Duration::from_secs(8)).expect("no event");
    assert_eq!(event, "delegate://received");
    assert_eq!(payload["delegationId"], "dg_test");
    let files = payload["files"].as_array().expect("files array");
    assert!(files.iter().any(|f| f["name"] == "result.md"
      && f["content"].as_str().unwrap_or_default().contains("42")));

    handle.join().unwrap();
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn timeout_event_fires_when_nothing_arrives() {
    let dir = temp_dir("timeout");
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std_channel::<(String, serde_json::Value)>();

    let watch_dir = dir.clone();
    let handle = std::thread::spawn(move || {
      watch_delegate_dir(
        watch_dir,
        "dg_timeout".into(),
        cancel,
        Duration::from_millis(1200), // configurable short timeout (spec gate 5)
        Duration::from_millis(500),
        move |event, payload| {
          let _ = tx.send((event.to_string(), payload));
        },
      );
    });

    let (event, payload) = rx.recv_timeout(Duration::from_secs(8)).expect("no event");
    assert_eq!(event, "delegate://timeout");
    assert_eq!(payload["delegationId"], "dg_timeout");

    handle.join().unwrap();
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn cancel_flag_stops_the_watcher_silently() {
    let dir = temp_dir("cancel");
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_thread = Arc::clone(&cancel);
    let (tx, rx) = std_channel::<(String, serde_json::Value)>();

    let watch_dir = dir.clone();
    let handle = std::thread::spawn(move || {
      watch_delegate_dir(
        watch_dir,
        "dg_cancel".into(),
        cancel_for_thread,
        Duration::from_secs(10),
        Duration::from_millis(500),
        move |event, payload| {
          let _ = tx.send((event.to_string(), payload));
        },
      );
    });

    std::thread::sleep(Duration::from_millis(300));
    cancel.store(true, Ordering::SeqCst);
    handle.join().unwrap();
    assert!(rx.try_recv().is_err(), "cancel must not emit any event");
    std::fs::remove_dir_all(&dir).ok();
  }
}
