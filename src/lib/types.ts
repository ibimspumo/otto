export type AgentState =
  | "disconnected"
  | "connecting"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking";

export interface Settings {
  openai_api_key: string;
  brave_api_key: string;
  openrouter_api_key: string;
  model: string;
  voice: string;
  reasoning_effort: string;
  image_model: string;
  codex_imagegen_enabled: boolean;
  terminal_enabled: boolean;
  wake_word_enabled: boolean;
  wake_word_phrase: string;
  hotkey_enabled: boolean;
  hotkey: string;
  cli_enabled: boolean;
  cli_default: string;
  cli_notes: string;
  yolo_mode: boolean;
  memory_enabled: boolean;
  memory_model: string;
  /** Remote-MCP-Server (eine Zeile pro Server: "label https://…" oder URL). */
  mcp_servers: string;
  session_retention_days: number;
  vad_threshold: number;
}


/**
 * App-Identität & TCC-Vorprüfung (aus Rust). Grundlage für den
 * Translocation-Hinweis und den Diagnose-Abschnitt der Einstellungen.
 */
export interface Diagnostics {
  exe_path: string;
  bundle_path: string | null;
  bundle_id: string;
  translocated: boolean;
  in_applications: boolean;
  dev_build: boolean;
  quarantined: boolean | null;
  accessibility: boolean;
}

/** Skill-Metadaten für die Progressive Disclosure (Name + Beschreibung). */
export interface SkillInfo {
  name: string;
  description: string;
}

/** Treffer der FTS5-Volltextsuche über alte Gespräche. */
export interface SessionSearchHit {
  session_id: number;
  started_ms: number;
  role: string;
  snippet: string;
}

/** Noch nicht in die Tagesnotizen extrahierte Session (Catch-up-Flush). */
export interface UnprocessedSession {
  id: number;
  started_ms: number;
  transcript: string;
}

/** Laufender Hintergrund-Job (delegate_task an Codex/Claude CLI). */
export interface CliJob {
  id: string;
  agent: string;
  task: string;
  /** Startzeit (ms) — mtime-Guard für den Bild-Auto-Import nach Job-Ende. */
  startedAt?: number;
}

export type ArtifactKind = "markdown" | "code" | "search" | "image" | "job";

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface ImageMeta {
  id: string;
  file: string;
  name: string;
  prompt: string;
  created_ms: number;
  favorite: boolean;
  transparent: boolean;
  size: string;
  path: string;
}

export interface ImageState {
  status: "generating" | "done" | "error";
  /** data:-URL während/nach Generierung oder asset://-URL nach Neustart */
  url?: string;
  meta?: ImageMeta;
  error?: string;
  /**
   * Angeforderte Pixelmaße ("1536x1024") — schon während der Generierung
   * gesetzt, damit Quick Look das Fenster in der echten Aspect Ratio
   * aufziehen kann, bevor das Bild fertig ist.
   */
  size?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  age?: string | null;
  host?: string | null;
  /** Vorschaubild (News/Bilder/Videos-Suche). */
  thumbnail?: string | null;
  /** Videolänge (nur Videos-Suche). */
  duration?: string | null;
}

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  language?: string;
  results?: SearchResult[];
  imageIds?: string[];
  updatedAt: number;
  /** Gläserne Jobs: Live-Terminal eines Hintergrund-Jobs als Artefakt. */
  jobId?: string;
  jobAgent?: string;
  jobStatus?: JobStatus;
  /** Letzte Output-Zeilen (Ringpuffer) für Mini- und Vollansicht. */
  jobLines?: string[];
  exitCode?: number | null;
}

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}
