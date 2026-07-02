// Persistente Gesprächsprotokolle: SQLite mit FTS5-Volltextindex.
//
// Jede Realtime-Session wird mitgeschrieben (session_start/append/end).
// `processed` markiert, ob der Memory-Flush die Session schon in die
// Tagesnotizen extrahiert hat — der Catch-up-Job beim App-Start holt
// verpasste Sessions nach. Roh-Transkripte werden nach `retention`
// Tagen gelöscht; die Essenz lebt dann in memory/ und MEMORY.md weiter.

use rusqlite::Connection;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

fn db() -> &'static Mutex<Option<Connection>> {
    static DB: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
    DB.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn with_conn<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let mut guard = db().lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let db_path = dir.join("sessions.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS sessions(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               started_ms INTEGER NOT NULL,
               ended_ms INTEGER,
               processed INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS items(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               session_id INTEGER NOT NULL,
               ts_ms INTEGER NOT NULL,
               role TEXT NOT NULL,
               text TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_items_session ON items(session_id);
             CREATE VIRTUAL TABLE IF NOT EXISTS items_fts
               USING fts5(text, content='items', content_rowid='id');
             CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
               INSERT INTO items_fts(rowid, text) VALUES (new.id, new.text);
             END;
             CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
               INSERT INTO items_fts(items_fts, rowid, text) VALUES('delete', old.id, old.text);
             END;",
        )
        .map_err(|e| e.to_string())?;
        *guard = Some(conn);
    }
    f(guard.as_ref().unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_start(app: tauri::AppHandle) -> Result<i64, String> {
    with_conn(&app, |c| {
        c.execute("INSERT INTO sessions(started_ms) VALUES (?1)", [now_ms()])?;
        Ok(c.last_insert_rowid())
    })
}

#[tauri::command]
pub fn session_append(
    app: tauri::AppHandle,
    session_id: i64,
    role: String,
    text: String,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    with_conn(&app, |c| {
        c.execute(
            "INSERT INTO items(session_id, ts_ms, role, text) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, now_ms(), role, text],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn session_end(app: tauri::AppHandle, session_id: i64) -> Result<(), String> {
    with_conn(&app, |c| {
        c.execute(
            "UPDATE sessions SET ended_ms = ?1 WHERE id = ?2",
            rusqlite::params![now_ms(), session_id],
        )?;
        Ok(())
    })
}

#[derive(Serialize)]
pub struct SearchHit {
    pub session_id: i64,
    pub started_ms: i64,
    pub role: String,
    pub snippet: String,
}

/// FTS5-Volltextsuche über alle gespeicherten Gespräche.
/// Die Anfrage wird als Phrasen-Terme escaped, damit FTS-Syntaxfehler
/// (Bindestriche, Anführungszeichen …) nie beim Nutzer landen.
#[tauri::command]
pub fn sessions_search(
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchHit>, String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .filter(|t| t.len() > 2)
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let fts_query = terms.join(" ");
    let limit = limit.unwrap_or(12).clamp(1, 40);
    with_conn(&app, |c| {
        let mut stmt = c.prepare(
            "SELECT i.session_id, s.started_ms, i.role,
                    snippet(items_fts, 0, '»', '«', ' … ', 24)
             FROM items_fts
             JOIN items i ON i.id = items_fts.rowid
             JOIN sessions s ON s.id = i.session_id
             WHERE items_fts MATCH ?1
             ORDER BY s.started_ms DESC, i.ts_ms ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![fts_query, limit], |r| {
            Ok(SearchHit {
                session_id: r.get(0)?,
                started_ms: r.get(1)?,
                role: r.get(2)?,
                snippet: r.get(3)?,
            })
        })?;
        rows.collect()
    })
}

#[derive(Serialize)]
pub struct UnprocessedSession {
    pub id: i64,
    pub started_ms: i64,
    pub transcript: String,
}

/// Beendete, noch nicht in die Tagesnotizen extrahierte Sessions —
/// Grundlage für den Catch-up-Flush beim App-Start.
#[tauri::command]
pub fn sessions_unprocessed(app: tauri::AppHandle) -> Result<Vec<UnprocessedSession>, String> {
    with_conn(&app, |c| {
        // Verwaiste Sessions (App-Absturz oder Beenden ohne Disconnect)
        // nach 6 h als beendet markieren, damit der Flush sie erfasst.
        let stale = now_ms() - 6 * 60 * 60 * 1000;
        c.execute(
            "UPDATE sessions SET ended_ms = started_ms
             WHERE ended_ms IS NULL AND started_ms < ?1",
            [stale],
        )?;
        let mut stmt = c.prepare(
            "SELECT id, started_ms FROM sessions
             WHERE processed = 0 AND ended_ms IS NOT NULL
             ORDER BY started_ms ASC LIMIT 20",
        )?;
        let sessions: Vec<(i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (id, started_ms) in sessions {
            let mut items = c.prepare(
                "SELECT role, text FROM items WHERE session_id = ?1 ORDER BY ts_ms ASC",
            )?;
            let lines: Vec<String> = items
                .query_map([id], |r| {
                    let role: String = r.get(0)?;
                    let text: String = r.get(1)?;
                    Ok(format!(
                        "{}: {}",
                        if role == "user" { "NUTZER" } else { "OTTO" },
                        text
                    ))
                })?
                .collect::<rusqlite::Result<_>>()?;
            let mut transcript = lines.join("\n");
            if transcript.len() > 24_000 {
                let cut = transcript.len() - 24_000;
                let start = transcript
                    .char_indices()
                    .map(|(i, _)| i)
                    .find(|&i| i >= cut)
                    .unwrap_or(0);
                transcript = format!("[…gekürzt]\n{}", &transcript[start..]);
            }
            out.push(UnprocessedSession {
                id,
                started_ms,
                transcript,
            });
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn session_mark_processed(app: tauri::AppHandle, session_id: i64) -> Result<(), String> {
    with_conn(&app, |c| {
        c.execute(
            "UPDATE sessions SET processed = 1 WHERE id = ?1",
            [session_id],
        )?;
        Ok(())
    })
}

/// Löscht verarbeitete Roh-Transkripte, die älter als `days` Tage sind.
#[tauri::command]
pub fn sessions_cleanup(app: tauri::AppHandle, days: u32) -> Result<u32, String> {
    let cutoff = now_ms() - (days as i64) * 24 * 60 * 60 * 1000;
    with_conn(&app, |c| {
        c.execute(
            "DELETE FROM items WHERE session_id IN
               (SELECT id FROM sessions WHERE processed = 1 AND started_ms < ?1)",
            [cutoff],
        )?;
        let n = c.execute(
            "DELETE FROM sessions WHERE processed = 1 AND started_ms < ?1",
            [cutoff],
        )?;
        Ok(n as u32)
    })
}
