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
  computer_model: string;
  computer_use_enabled: boolean;
  terminal_enabled: boolean;
}

export type ArtifactKind = "markdown" | "code" | "html" | "search" | "image";

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
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  age?: string | null;
  host?: string | null;
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
}

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}
