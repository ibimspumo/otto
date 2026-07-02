import { invoke } from "@tauri-apps/api/core";
import type { ImageMeta, SearchResult, Settings } from "./types";

export const getSettings = () => invoke<Settings>("get_settings");

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

export const braveSearch = (query: string, apiKey: string, count?: number) =>
  invoke<{ query: string; results: SearchResult[] }>("brave_search", {
    query,
    apiKey,
    count,
  });
