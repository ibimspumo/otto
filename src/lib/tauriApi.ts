import { invoke } from "@tauri-apps/api/core";
import type {
  Diagnostics,
  ImageMeta,
  SearchResult,
  SessionSearchHit,
  Settings,
  SkillInfo,
  UnprocessedSession,
} from "./types";

export const getSettings = () => invoke<Settings>("get_settings");

/** App-Identität & TCC-Vorprüfung (Translocation, /Applications, Freigaben). */
export const appDiagnostics = () => invoke<Diagnostics>("app_diagnostics");

/** Doppel-Cmd-Erkennung (globaler NSEvent-Monitor) starten/stoppen. */
export const dblcmdStart = () => invoke<void>("dblcmd_start");
export const dblcmdStop = () => invoke<void>("dblcmd_stop");

/** Interne Diagnose-Zeile nach otto.log schreiben (nie in die UI). */
export const logLine = (line: string) =>
  invoke<void>("log_line", { line }).catch(() => {});

export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });

export const listAgentFiles = () => invoke<string[]>("list_agent_files");

export const readAgentFile = (name: string) =>
  invoke<string>("read_agent_file", { name });

export const writeAgentFile = (name: string, content: string) =>
  invoke<void>("write_agent_file", { name, content });

export const agentDirPath = () => invoke<string>("agent_dir_path");

export const runComputerUse = (task: string, apiKey: string, model?: string) =>
  invoke<string>("run_computer_use", { task, apiKey, model });

export const cuCancel = () => invoke<void>("cu_cancel");

export const runTerminal = (command: string, timeoutS?: number) =>
  invoke<{ exit_code: number | null; stdout: string; stderr: string }>(
    "run_terminal",
    { command, timeoutS },
  );

export const cuPermissions = (request: boolean) =>
  invoke<{ screen: boolean; accessibility: boolean }>("cu_permissions", {
    request,
  });

export const imagesList = () => invoke<ImageMeta[]>("images_list");

export const imageStore = (
  id: string,
  name: string,
  prompt: string,
  b64: string,
  transparent: boolean,
  size: string,
) => invoke<ImageMeta>("image_store", { id, name, prompt, b64, transparent, size });

export const imageReadB64 = (id: string) =>
  invoke<string>("image_read_b64", { id });

export const imageDelete = (id: string) => invoke<void>("image_delete", { id });

export const imageRename = (id: string, name: string) =>
  invoke<void>("image_rename", { id, name });

export const imageFavorite = (id: string, favorite: boolean) =>
  invoke<void>("image_favorite", { id, favorite });

export const imageExport = (id: string, dest?: string) =>
  invoke<string>("image_export", { id, dest });

export const imageImport = (source: string, name?: string) =>
  invoke<ImageMeta>("image_import", { source, name });

export const cliJobStart = (agent: string, task: string, cwd?: string) =>
  invoke<string>("cli_job_start", { agent, task, cwd });

export const cliJobCancel = (jobId: string) =>
  invoke<string[]>("cli_job_cancel", { jobId });

export const cliAvailable = () =>
  invoke<{ codex: boolean; claude: boolean }>("cli_available");

export const wakeWordStart = (phrases: string[]) =>
  invoke<void>("wake_word_start", { phrases });

export const wakeWordStop = () => invoke<void>("wake_word_stop");

export const braveSearch = (query: string, apiKey: string, count?: number) =>
  invoke<{ query: string; results: SearchResult[] }>("brave_search", {
    query,
    apiKey,
    count,
  });

// --- Session-Persistenz (SQLite + FTS5) ---

export const sessionStart = () => invoke<number>("session_start");

export const sessionAppend = (sessionId: number, role: string, text: string) =>
  invoke<void>("session_append", { sessionId, role, text });

export const sessionEnd = (sessionId: number) =>
  invoke<void>("session_end", { sessionId });

export const sessionsSearch = (query: string, limit?: number) =>
  invoke<SessionSearchHit[]>("sessions_search", { query, limit });

export const sessionsUnprocessed = () =>
  invoke<UnprocessedSession[]>("sessions_unprocessed");

export const sessionMarkProcessed = (sessionId: number) =>
  invoke<void>("session_mark_processed", { sessionId });

export const sessionsCleanup = (days: number) =>
  invoke<number>("sessions_cleanup", { days });

// --- Gedächtnis (Tagesnotizen + Konsolidierungs-State) ---

export const memoryNoteAppend = (text: string, date?: string) =>
  invoke<void>("memory_note_append", { text, date });

export const memoryNotesRecent = (days: number) =>
  invoke<string>("memory_notes_recent", { days });

export const memoryNotesCleanup = (keepDays: number) =>
  invoke<number>("memory_notes_cleanup", { keepDays });

export const memoryStateGet = () =>
  invoke<Record<string, unknown>>("memory_state_get");

export const memoryStateSet = (state: Record<string, unknown>) =>
  invoke<void>("memory_state_set", { state });

// --- Skills ---

export const skillsList = () => invoke<SkillInfo[]>("skills_list");

export const skillRead = (name: string) =>
  invoke<string>("skill_read", { name });

export const skillWrite = (name: string, content: string) =>
  invoke<void>("skill_write", { name, content });

export const skillDelete = (name: string) =>
  invoke<void>("skill_delete", { name });
