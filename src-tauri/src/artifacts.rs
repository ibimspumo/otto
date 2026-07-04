// Persistentes Artefakt-Journal: lokale SQLite-Grundlage fuer spaetere
// Journal-/Stage-Ansichten. Das sichtbare Drop-Panel bleibt weiter
// fluechtig; dieses Modul speichert nur die Metadaten und Inhalte.

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
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
        let db_path = dir.join("artifacts.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS artifacts(
               id TEXT PRIMARY KEY NOT NULL,
               kind TEXT NOT NULL,
               title TEXT NOT NULL,
               summary TEXT NOT NULL,
               content TEXT NOT NULL,
               language TEXT,
               results_json TEXT,
               image_ids_json TEXT NOT NULL DEFAULT '[]',
               source_urls_json TEXT NOT NULL DEFAULT '[]',
               parent_ids_json TEXT NOT NULL DEFAULT '[]',
               job_id TEXT,
               job_agent TEXT,
               job_status TEXT,
               job_lines_json TEXT,
               exit_code INTEGER,
               created_ms INTEGER NOT NULL,
               updated_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_artifacts_updated
               ON artifacts(updated_ms DESC);
             CREATE INDEX IF NOT EXISTS idx_artifacts_kind_updated
               ON artifacts(kind, updated_ms DESC);
             CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts
               USING fts5(title, summary, content, content='artifacts', content_rowid='rowid');
             CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
               INSERT INTO artifacts_fts(rowid, title, summary, content)
               VALUES (new.rowid, new.title, new.summary, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
               INSERT INTO artifacts_fts(artifacts_fts, rowid, title, summary, content)
               VALUES('delete', old.rowid, old.title, old.summary, old.content);
             END;
             CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
               INSERT INTO artifacts_fts(artifacts_fts, rowid, title, summary, content)
               VALUES('delete', old.rowid, old.title, old.summary, old.content);
               INSERT INTO artifacts_fts(rowid, title, summary, content)
               VALUES (new.rowid, new.title, new.summary, new.content);
             END;",
        )
        .map_err(|e| e.to_string())?;
        *guard = Some(conn);
    }
    f(guard.as_ref().unwrap()).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactJournalEntry {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub summary: String,
    pub content: String,
    pub language: Option<String>,
    pub results: Option<Vec<Value>>,
    pub image_ids: Vec<String>,
    pub source_urls: Vec<String>,
    pub parent_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub job_id: Option<String>,
    pub job_agent: Option<String>,
    pub job_status: Option<String>,
    pub job_lines: Option<Vec<String>>,
    pub exit_code: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactJournalInput {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub summary: Option<String>,
    pub content: Option<String>,
    pub language: Option<String>,
    pub results: Option<Vec<Value>>,
    pub image_ids: Option<Vec<String>>,
    pub source_urls: Option<Vec<String>>,
    pub parent_ids: Option<Vec<String>>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub job_id: Option<String>,
    pub job_agent: Option<String>,
    pub job_status: Option<String>,
    pub job_lines: Option<Vec<String>>,
    pub exit_code: Option<i64>,
}

const COLUMNS: &str = "a.id, a.kind, a.title, a.summary, a.content, a.language,
       a.results_json, a.image_ids_json, a.source_urls_json, a.parent_ids_json,
       a.job_id, a.job_agent, a.job_status, a.job_lines_json, a.exit_code,
       a.created_ms, a.updated_ms";

fn validate_kind(kind: &str) -> Result<String, String> {
    let kind = kind.trim().to_ascii_lowercase();
    match kind.as_str() {
        "markdown" | "code" | "search" | "image" | "job" => Ok(kind),
        _ => Err(format!("Unbekannter Artefakt-Typ: {kind}")),
    }
}

fn clean_text(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn clamp_chars(value: &str, max: usize) -> String {
    let value = clean_text(value);
    if value.chars().count() <= max {
        return value;
    }
    let keep = max.saturating_sub(3);
    format!("{}...", value.chars().take(keep).collect::<String>())
}

fn summary_for(input: &ArtifactJournalInput, title: &str, content: &str) -> String {
    let raw = input
        .summary
        .as_deref()
        .map(clean_text)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let body = clean_text(content);
            if body.is_empty() {
                clean_text(title)
            } else {
                body
            }
        });
    clamp_chars(&raw, 100)
}

fn json_string<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
}

fn json_vec<T: DeserializeOwned>(raw: Option<String>) -> Vec<T> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn json_opt_vec<T: DeserializeOwned>(raw: Option<String>) -> Option<Vec<T>> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

fn dedupe_nonempty(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if !value.is_empty() && seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn source_urls_from_results(results: &Option<Vec<Value>>) -> Vec<String> {
    results
        .as_ref()
        .into_iter()
        .flat_map(|items| items.iter())
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .map(ToString::to_string)
        .collect()
}

fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| t.chars().count() > 1)
        .map(|t| format!("\"{t}\""))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

fn row_to_entry(row: &Row<'_>) -> rusqlite::Result<ArtifactJournalEntry> {
    let results: Option<Vec<Value>> = json_opt_vec(row.get(6)?);
    let job_lines: Option<Vec<String>> = json_opt_vec(row.get(13)?);
    Ok(ArtifactJournalEntry {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        summary: row.get(3)?,
        content: row.get(4)?,
        language: row.get(5)?,
        results,
        image_ids: json_vec(row.get(7)?),
        source_urls: json_vec(row.get(8)?),
        parent_ids: json_vec(row.get(9)?),
        job_id: row.get(10)?,
        job_agent: row.get(11)?,
        job_status: row.get(12)?,
        job_lines,
        exit_code: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

#[tauri::command]
pub fn artifact_journal_upsert(
    app: tauri::AppHandle,
    entry: ArtifactJournalInput,
) -> Result<ArtifactJournalEntry, String> {
    let id = entry.id.trim().to_string();
    if id.is_empty() {
        return Err("Artefakt-id fehlt.".into());
    }
    let kind = validate_kind(&entry.kind)?;
    let title = entry.title.trim();
    let title = if title.is_empty() { "Ohne Titel" } else { title }.to_string();
    let content = entry.content.clone().unwrap_or_default();
    let summary = summary_for(&entry, &title, &content);
    let image_ids = dedupe_nonempty(entry.image_ids.clone().unwrap_or_default());
    let parent_ids = dedupe_nonempty(entry.parent_ids.clone().unwrap_or_default());
    let source_urls = dedupe_nonempty(
        entry
            .source_urls
            .clone()
            .unwrap_or_default()
            .into_iter()
            .chain(source_urls_from_results(&entry.results)),
    );
    let language = entry.language.clone();
    let results = entry.results.clone();
    let job_id = entry.job_id.clone();
    let job_agent = entry.job_agent.clone();
    let job_status = entry.job_status.clone();
    let job_lines = entry.job_lines.clone();
    let exit_code = entry.exit_code;
    let now = now_ms();

    with_conn(&app, |c| {
        let existing_created: Option<i64> = c
            .query_row(
                "SELECT created_ms FROM artifacts WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        let created_ms = entry
            .created_at
            .filter(|v| *v > 0)
            .or(existing_created)
            .unwrap_or(now);
        let updated_ms = entry.updated_at.filter(|v| *v > 0).unwrap_or(now).max(created_ms);
        let results_json = match results.as_ref() {
            Some(v) => Some(json_string(v)?),
            None => None,
        };
        let job_lines_json = match job_lines.as_ref() {
            Some(v) => Some(json_string(v)?),
            None => None,
        };
        c.execute(
            "INSERT INTO artifacts(
               id, kind, title, summary, content, language, results_json,
               image_ids_json, source_urls_json, parent_ids_json,
               job_id, job_agent, job_status, job_lines_json, exit_code,
               created_ms, updated_ms
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7,
               ?8, ?9, ?10,
               ?11, ?12, ?13, ?14, ?15,
               ?16, ?17
             )
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               title = excluded.title,
               summary = excluded.summary,
               content = excluded.content,
               language = excluded.language,
               results_json = excluded.results_json,
               image_ids_json = excluded.image_ids_json,
               source_urls_json = excluded.source_urls_json,
               parent_ids_json = excluded.parent_ids_json,
               job_id = excluded.job_id,
               job_agent = excluded.job_agent,
               job_status = excluded.job_status,
               job_lines_json = excluded.job_lines_json,
               exit_code = excluded.exit_code,
               updated_ms = excluded.updated_ms",
            rusqlite::params![
                &id,
                &kind,
                &title,
                &summary,
                &content,
                language,
                results_json,
                json_string(&image_ids)?,
                json_string(&source_urls)?,
                json_string(&parent_ids)?,
                job_id,
                job_agent,
                job_status,
                job_lines_json,
                exit_code,
                created_ms,
                updated_ms,
            ],
        )?;
        c.query_row(
            &format!("SELECT {COLUMNS} FROM artifacts a WHERE a.id = ?1"),
            rusqlite::params![&id],
            row_to_entry,
        )
    })
}

#[tauri::command]
pub fn artifact_journal_get(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<ArtifactJournalEntry>, String> {
    with_conn(&app, |c| {
        c.query_row(
            &format!("SELECT {COLUMNS} FROM artifacts a WHERE a.id = ?1"),
            [id],
            row_to_entry,
        )
        .optional()
    })
}

#[tauri::command]
pub fn artifact_journal_list(
    app: tauri::AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
    kind: Option<String>,
    query: Option<String>,
) -> Result<Vec<ArtifactJournalEntry>, String> {
    let limit = i64::from(limit.unwrap_or(80).clamp(1, 200));
    let offset = i64::from(offset.unwrap_or(0));
    let kind = match kind {
        Some(k) if !k.trim().is_empty() => Some(validate_kind(&k)?),
        _ => None,
    };
    let q = query.as_deref().and_then(fts_query);

    with_conn(&app, |c| {
        let rows = match (q, kind) {
            (Some(q), Some(kind)) => {
                let sql = format!(
                    "SELECT {COLUMNS}
                     FROM artifacts_fts
                     JOIN artifacts a ON a.rowid = artifacts_fts.rowid
                     WHERE artifacts_fts MATCH ?1 AND a.kind = ?2
                     ORDER BY a.updated_ms DESC
                     LIMIT ?3 OFFSET ?4"
                );
                let mut stmt = c.prepare(&sql)?;
                let rows = stmt.query_map(rusqlite::params![q, kind, limit, offset], row_to_entry)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            (Some(q), None) => {
                let sql = format!(
                    "SELECT {COLUMNS}
                     FROM artifacts_fts
                     JOIN artifacts a ON a.rowid = artifacts_fts.rowid
                     WHERE artifacts_fts MATCH ?1
                     ORDER BY a.updated_ms DESC
                     LIMIT ?2 OFFSET ?3"
                );
                let mut stmt = c.prepare(&sql)?;
                let rows = stmt.query_map(rusqlite::params![q, limit, offset], row_to_entry)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            (None, Some(kind)) => {
                let sql = format!(
                    "SELECT {COLUMNS}
                     FROM artifacts a
                     WHERE a.kind = ?1
                     ORDER BY a.updated_ms DESC
                     LIMIT ?2 OFFSET ?3"
                );
                let mut stmt = c.prepare(&sql)?;
                let rows = stmt.query_map(rusqlite::params![kind, limit, offset], row_to_entry)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            (None, None) => {
                let sql = format!(
                    "SELECT {COLUMNS}
                     FROM artifacts a
                     ORDER BY a.updated_ms DESC
                     LIMIT ?1 OFFSET ?2"
                );
                let mut stmt = c.prepare(&sql)?;
                let rows = stmt.query_map(rusqlite::params![limit, offset], row_to_entry)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(rows)
    })
}

#[tauri::command]
pub fn artifact_journal_delete(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    with_conn(&app, |c| {
        let n = c.execute("DELETE FROM artifacts WHERE id = ?1", [id])?;
        Ok(n > 0)
    })
}
