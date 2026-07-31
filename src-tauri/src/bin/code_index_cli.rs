// ================================================================
//  code_index_cli — minimal dev/E2E harness for the Phase 5 index
//
//  Usage (from src-tauri/):
//    cargo run --bin code_index_cli -- full <repoPath>
//    cargo run --bin code_index_cli -- incremental <repoPath>
//    cargo run --bin code_index_cli -- query <repoPath> <query> [topK]
//    cargo run --bin code_index_cli -- stats <repoPath>
//
//  Writes to the same {FLOWFORGE_DATA_DIR || ~/.flowforge}/code_index/
//  {repoHash}.db the Tauri commands and the sidecar code.search use —
//  which is exactly what the E2E smoke gate needs.
// ================================================================

use std::path::PathBuf;

use app_lib::commands::code_index::{full_index, index_db_path, index_stats, query_index};
use app_lib::commands::git_ops::incremental_index;

fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let usage = "usage: code_index_cli <full|incremental|query|stats> <repoPath> [query] [topK]";
  let (cmd, repo) = match (args.first(), args.get(1)) {
    (Some(c), Some(r)) => (c.as_str(), PathBuf::from(r)),
    _ => {
      eprintln!("{usage}");
      std::process::exit(2);
    }
  };
  let db = index_db_path(&repo);

  let result = match cmd {
    "full" => full_index(&repo, &db).map(|s| serde_json::to_value(s).unwrap_or_default()),
    "incremental" => {
      incremental_index(&repo, &db).map(|s| serde_json::to_value(s).unwrap_or_default())
    }
    "query" => {
      let query = args.get(2).cloned().unwrap_or_default();
      let top_k = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(5);
      let started = std::time::Instant::now();
      query_index(&db, &query, top_k).map(|hits| {
        serde_json::json!({
          "durationMs": started.elapsed().as_millis(),
          "hits": hits,
        })
      })
    }
    "stats" => index_stats(&db).map(|s| serde_json::to_value(s).unwrap_or_default()),
    _ => {
      eprintln!("{usage}");
      std::process::exit(2);
    }
  };

  match result {
    Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default()),
    Err(e) => {
      eprintln!("error: {e}");
      std::process::exit(1);
    }
  }
}
