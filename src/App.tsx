import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioEngine } from "./lib/audio";
import { enterMiniMode, exitMiniMode } from "./lib/miniMode";
import { checkForUpdate, installAndRelaunch, type Update } from "./lib/updater";
import {
  editImages,
  generateImage,
  generateImagesOpenRouter,
  isOpenAiImageModel,
  resolveSize,
  type Aspect,
  type Quality,
  type Resolution,
} from "./lib/imagegen";
import { RealtimeClient, type FunctionCall } from "./lib/realtime";
import { INSTRUCTIONS_PREAMBLE, toolDefs } from "./lib/tools";
import * as api from "./lib/tauriApi";
import type {
  AgentState,
  Artifact,
  ArtifactKind,
  ImageMeta,
  ImageState,
  Settings,
  TranscriptItem,
} from "./lib/types";
import VoicePanel from "./components/VoicePanel";
import ArtifactPanel from "./components/ArtifactPanel";
import FilesPanel from "./components/FilesPanel";
import SettingsPanel from "./components/SettingsPanel";

type View = "talk" | "files" | "settings";

const NAV: { view: View; label: string; icon: React.ReactNode }[] = [
  {
    view: "talk",
    label: "Sprechen",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2a10 10 0 0 1 10 10" opacity="0.5" />
        <path d="M12 22A10 10 0 0 1 2 12" opacity="0.5" />
      </svg>
    ),
  },
  {
    view: "files",
    label: "Dateien",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M6 2h9l4 4v16H6z" />
        <path d="M9 11h7M9 15h7" opacity="0.6" />
      </svg>
    ),
  },
  {
    view: "settings",
    label: "Einstellungen",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
        <circle cx="16" cy="8" r="2" />
        <circle cx="8" cy="16" r="2" />
      </svg>
    ),
  },
];

const STATE_LABEL: Record<AgentState, string> = {
  disconnected: "OFFLINE",
  connecting: "VERBINDE…",
  idle: "ONLINE",
  listening: "ONLINE",
  thinking: "ONLINE",
  speaking: "ONLINE",
};

/** Grobes Seitenverhältnis aus "1536x1024" ableiten. */
function aspectFromSize(size: string): Aspect {
  const [w, h] = size.split("x").map((v) => parseInt(v, 10));
  if (!w || !h || w === h) return "square";
  const ratio = w / h;
  if (ratio >= 1.6) return "wide";
  if (ratio > 1) return "landscape";
  return "portrait";
}

export default function App() {
  const [view, setView] = useState<View>("talk");
  const [agentState, setAgentState] = useState<AgentState>("disconnected");
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  const [artifactStyle, setArtifactStyle] = useState("");
  const [artifactsVisible, setArtifactsVisible] = useState(false);
  const [activities, setActivities] = useState<string[]>([]);
  const [images, setImages] = useState<Record<string, ImageState>>({});
  const imagesRef = useRef<Record<string, ImageState>>({});
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);

  // Beim Start still auf Updates prüfen (schlägt im Dev-Modus einfach fehl).
  useEffect(() => {
    checkForUpdate().then(setUpdate);
  }, []);

  async function startUpdate() {
    if (!update || updateProgress !== null) return;
    setUpdateProgress(0);
    try {
      await installAndRelaunch(update, setUpdateProgress);
    } catch (e) {
      setUpdateProgress(null);
      setError(`Update fehlgeschlagen: ${String(e)}`);
    }
  }
  const artifactsVisibleRef = useRef(false);
  useEffect(() => {
    artifactsVisibleRef.current = artifactsVisible;
  }, [artifactsVisible]);

  const levels = useRef({ inp: 0, out: 0 });
  const engineRef = useRef<AudioEngine | null>(null);
  const clientRef = useRef<RealtimeClient | null>(null);
  const artifactsRef = useRef<Artifact[]>([]);
  const seq = useRef(0);
  const pendingCreate = useRef(false);
  const flags = useRef({
    connected: false,
    connecting: false,
    userSpeaking: false,
    responseActive: false,
    playing: false,
    toolRunning: false,
  });

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
    reloadArtifactStyle();
  }, []);

  function reloadArtifactStyle() {
    api
      .readAgentFile("STYLE.css")
      .then(setArtifactStyle)
      .catch(() => setArtifactStyle(""));
  }

  const pushActivity = useCallback((text: string) => {
    setActivities((prev) => [text, ...prev].slice(0, 4));
  }, []);

  const setImage = useCallback((id: string, patch: Partial<ImageState>) => {
    setImages((prev) => {
      const next = {
        ...prev,
        [id]: { ...(prev[id] ?? { status: "generating" }), ...patch } as ImageState,
      };
      imagesRef.current = next;
      return next;
    });
  }, []);

  const newImageId = useCallback(
    () => `img-${Date.now().toString(36)}-${++seq.current}`,
    [],
  );

  // Galerie beim Start laden (Bilder liegen persistent im App-Datenordner).
  useEffect(() => {
    api
      .imagesList()
      .then((list) => {
        const map: Record<string, ImageState> = {};
        for (const m of list) {
          map[m.id] = { status: "done", url: convertFileSrc(m.path), meta: m };
        }
        imagesRef.current = map;
        setImages(map);
      })
      .catch(() => {});
  }, []);

  /**
   * Löst „img-…“, eine Galerie-Nummer („6“), einen Dateipfad oder eine URL
   * zu Metadaten auf. Pfade/URLs werden automatisch in die Galerie importiert
   * (inkl. Kompression auf max. 2048 px).
   */
  const resolveImageRef = useCallback(
    async (ref: string): Promise<ImageMeta | null> => {
      const trimmed = ref.trim();
      if (
        /^https?:\/\//.test(trimmed) ||
        trimmed.startsWith("/") ||
        trimmed.startsWith("~")
      ) {
        const meta = await api.imageImport(trimmed);
        setImage(meta.id, {
          status: "done",
          url: convertFileSrc(meta.path),
          meta,
        });
        return meta;
      }
      const list = await api.imagesList();
      if (/^\d+$/.test(trimmed)) {
        return list[parseInt(trimmed, 10) - 1] ?? null;
      }
      return list.find((m) => m.id === trimmed) ?? null;
    },
    [setImage],
  );

  // Mini-Orb-Fenster über Zustandswechsel auf dem Laufenden halten.
  useEffect(() => {
    void emit("otto-activity", { state: agentState });
  }, [agentState]);

  // Computer-Use-Schritte aus Rust in die Aktivitätsanzeige spiegeln.
  useEffect(() => {
    const un = listen<{ text: string }>("cu-status", (e) =>
      pushActivity(e.payload.text),
    );
    return () => {
      un.then((f) => f());
    };
  }, [pushActivity]);

  /**
   * response.create darf erst gesendet werden, wenn keine Antwort mehr läuft —
   * sonst lehnt der Server ab. Läuft eine, wird der Wunsch vorgemerkt und in
   * onResponseDone eingelöst. Startet der Server selbst eine Antwort (VAD),
   * deckt die alle offenen Items ab und der Vormerker verfällt.
   */
  const requestResponse = useCallback(() => {
    if (flags.current.responseActive) {
      pendingCreate.current = true;
    } else {
      clientRef.current?.createResponse();
    }
  }, []);

  const recompute = useCallback(() => {
    const f = flags.current;
    let next: AgentState;
    if (f.connecting) next = "connecting";
    else if (!f.connected) next = "disconnected";
    else if (f.userSpeaking) next = "listening";
    else if (f.playing) next = "speaking";
    else if (f.responseActive || f.toolRunning) next = "thinking";
    else next = "idle";
    setAgentState(next);
  }, []);

  // ----------------------------------------------------------------
  // Transkript
  // ----------------------------------------------------------------

  const pushUser = useCallback((text: string) => {
    if (!text) return;
    const id = `u${++seq.current}`;
    setTranscript((prev) => [...prev.slice(-60), { id, role: "user", text, final: true }]);
  }, []);

  const upsertAssistant = useCallback(
    (itemId: string, delta: string | null, finalText: string | null) => {
      const id = `as-${itemId}`;
      setTranscript((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) {
          return [
            ...prev.slice(-60),
            { id, role: "assistant" as const, text: finalText ?? delta ?? "", final: finalText !== null },
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          text: finalText !== null ? finalText : next[idx].text + (delta ?? ""),
          final: finalText !== null,
        };
        return next;
      });
    },
    [],
  );

  // ----------------------------------------------------------------
  // Artefakte
  // ----------------------------------------------------------------

  const commitArtifacts = useCallback((next: Artifact[], activeId?: string) => {
    artifactsRef.current = next;
    setArtifacts(next);
    if (activeId) setActiveArtifactId(activeId);
  }, []);

  const addArtifact = useCallback(
    (partial: Omit<Artifact, "id" | "updatedAt">): string => {
      const id = `a${++seq.current}`;
      commitArtifacts(
        [...artifactsRef.current, { ...partial, id, updatedAt: Date.now() }],
        id,
      );
      setArtifactsVisible(true);
      return id;
    },
    [commitArtifacts],
  );

  const closeArtifact = useCallback(
    (id: string): boolean => {
      const before = artifactsRef.current.length;
      const next = artifactsRef.current.filter((a) => a.id !== id);
      if (next.length === before) return false;
      commitArtifacts(next);
      setActiveArtifactId((prev) =>
        prev === id ? (next[next.length - 1]?.id ?? null) : prev,
      );
      if (next.length === 0) setArtifactsVisible(false);
      return true;
    },
    [commitArtifacts],
  );

  const removeImageEverywhere = useCallback(
    (id: string) => {
      setImages((prev) => {
        const next = { ...prev };
        delete next[id];
        imagesRef.current = next;
        return next;
      });
      const nextArts = artifactsRef.current
        .map((a) =>
          a.kind === "image" && a.imageIds
            ? { ...a, imageIds: a.imageIds.filter((x) => x !== id) }
            : a,
        )
        .filter((a) => !(a.kind === "image" && (a.imageIds?.length ?? 0) === 0));
      commitArtifacts(nextArts);
      setActiveArtifactId((prev) =>
        nextArts.some((a) => a.id === prev)
          ? prev
          : (nextArts[nextArts.length - 1]?.id ?? null),
      );
      if (nextArts.length === 0) setArtifactsVisible(false);
    },
    [commitArtifacts],
  );

  const handleImageAction = useCallback(
    async (id: string, action: "favorite" | "delete" | "save") => {
      try {
        if (action === "delete") {
          await api.imageDelete(id);
          removeImageEverywhere(id);
          pushActivity("löscht ein Bild aus der Galerie");
        } else if (action === "favorite") {
          const meta = imagesRef.current[id]?.meta;
          if (!meta) return;
          const favorite = !meta.favorite;
          await api.imageFavorite(id, favorite);
          setImage(id, { meta: { ...meta, favorite } });
        } else if (action === "save") {
          const path = await api.imageExport(id);
          pushActivity(`speichert Bild: ${path}`);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [pushActivity, removeImageEverywhere, setImage],
  );

  // ----------------------------------------------------------------
  // Werkzeuge
  // ----------------------------------------------------------------

  const executeTool = useCallback(
    async (call: FunctionCall) => {
      flags.current.toolRunning = true;
      recompute();
      const args = call.args as Record<string, any>;
      let out: object;
      try {
        switch (call.name) {
          case "create_artifact": {
            const kind: ArtifactKind = ["markdown", "code", "html"].includes(args.kind)
              ? args.kind
              : "markdown";
            const title = String(args.title ?? "Ohne Titel");
            const id = addArtifact({
              title,
              kind,
              language: args.language ? String(args.language) : undefined,
              content: String(args.content ?? ""),
            });
            pushActivity(`erstellt Artefakt „${title}“`);
            out = { ok: true, id, note: "Artefakt wird angezeigt." };
            break;
          }
          case "update_artifact": {
            const idx = artifactsRef.current.findIndex((a) => a.id === args.id);
            if (idx === -1) {
              out = {
                ok: false,
                error: `Artefakt ${args.id} nicht gefunden. Vorhandene ids: ${artifactsRef.current.map((a) => a.id).join(", ") || "keine"}`,
              };
            } else {
              const next = [...artifactsRef.current];
              next[idx] = {
                ...next[idx],
                content: String(args.content ?? ""),
                title: args.title ? String(args.title) : next[idx].title,
                updatedAt: Date.now(),
              };
              commitArtifacts(next, next[idx].id);
              setArtifactsVisible(true);
              pushActivity(`aktualisiert „${next[idx].title}“`);
              out = { ok: true, id: next[idx].id };
            }
            break;
          }
          case "web_search": {
            const key = settingsRefValue.current?.brave_api_key?.trim() ?? "";
            if (!key) {
              out = {
                ok: false,
                error:
                  "Kein Brave-API-Key hinterlegt. Sag dem Nutzer, dass er ihn in den Einstellungen eintragen kann.",
              };
              break;
            }
            const query = String(args.query ?? "");
            pushActivity(`durchsucht das Web: „${query}“`);
            const res = await api.braveSearch(
              query,
              key,
              typeof args.count === "number" ? args.count : undefined,
            );
            const artifactId = addArtifact({
              title: `Suche: ${res.query}`,
              kind: "search",
              content: res.query,
              results: res.results,
            });
            out = { ok: true, artifact_id: artifactId, results: res.results };
            break;
          }
          case "toggle_artifact_panel": {
            const visible = Boolean(args.visible);
            setArtifactsVisible(visible);
            pushActivity(visible ? "öffnet das Artefakt-Panel" : "schließt das Artefakt-Panel");
            out = { ok: true };
            break;
          }
          case "close_artifact": {
            const id = String(args.id ?? "");
            if (id === "all") {
              commitArtifacts([]);
              setActiveArtifactId(null);
              setArtifactsVisible(false);
              pushActivity("schließt alle Artefakte");
              out = { ok: true };
            } else if (closeArtifact(id)) {
              pushActivity(`schließt Artefakt ${id}`);
              out = { ok: true };
            } else {
              out = {
                ok: false,
                error: `Artefakt ${id} nicht gefunden.`,
                offene_artefakte: artifactsRef.current.map((a) => ({
                  id: a.id,
                  titel: a.title,
                  typ: a.kind,
                })),
              };
            }
            break;
          }
          case "list_artifacts": {
            out = {
              ok: true,
              sichtbar: artifactsVisibleRef.current,
              artefakte: artifactsRef.current.map((a) => ({
                id: a.id,
                titel: a.title,
                typ: a.kind,
              })),
            };
            break;
          }
          case "run_terminal": {
            if (!settingsRefValue.current?.terminal_enabled) {
              out = {
                ok: false,
                error: "Terminal-Befehle sind in den Einstellungen deaktiviert.",
              };
              break;
            }
            const command = String(args.command ?? "").trim();
            if (!command) {
              out = { ok: false, error: "Leerer Befehl." };
              break;
            }
            pushActivity(`Terminal: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""}`);
            try {
              const res = await api.runTerminal(
                command,
                typeof args.timeout_s === "number" ? args.timeout_s : undefined,
              );
              out = { ok: true, ...res };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "computer_use": {
            if (!settingsRefValue.current?.computer_use_enabled) {
              out = {
                ok: false,
                error: "Computer Use ist in den Einstellungen deaktiviert.",
              };
              break;
            }
            const key = settingsRefValue.current?.openai_api_key?.trim() ?? "";
            const task = String(args.task ?? "");
            pushActivity(`übernimmt den Computer: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`);
            await enterMiniMode();
            try {
              const result = await api.runComputerUse(
                task,
                key,
                settingsRefValue.current?.computer_model,
              );
              out = { ok: true, result };
            } catch (e) {
              setError(String(e));
              out = { ok: false, error: String(e) };
            } finally {
              await exitMiniMode();
            }
            break;
          }
          case "generate_image": {
            const s = settingsRefValue.current;
            const transparentWanted = Boolean(args.transparent);
            // Transparenz beherrscht nur gpt-image-1 → bei Bedarf umschalten.
            let model = s?.image_model?.trim() || "gpt-image-2";
            let modelNote: string | undefined;
            if (transparentWanted && model !== "gpt-image-1") {
              model = "gpt-image-1";
              modelNote =
                "Transparenz kann nur gpt-image-1 (OpenAI) — Modell dafür automatisch gewechselt.";
            }
            const useOpenAi = isOpenAiImageModel(model);
            const key = useOpenAi
              ? (s?.openai_api_key?.trim() ?? "")
              : (s?.openrouter_api_key?.trim() ?? "");
            if (!key) {
              out = {
                ok: false,
                error: useOpenAi
                  ? "Kein OpenAI-API-Key hinterlegt."
                  : "Kein OpenRouter-API-Key hinterlegt (nötig für Nano Banana).",
              };
              break;
            }
            const prompt = String(args.prompt ?? "");
            const n = Math.max(1, Math.min(8, Number(args.n) || 1));
            const aspect = (
              ["square", "landscape", "portrait", "wide"].includes(args.aspect)
                ? args.aspect
                : "square"
            ) as Aspect;
            const resolution = (
              ["1K", "2K", "4K"].includes(args.resolution) ? args.resolution : "1K"
            ) as Resolution;
            const quality = (
              ["low", "medium", "high", "auto"].includes(args.quality)
                ? args.quality
                : "auto"
            ) as Quality;
            const transparent = transparentWanted && model === "gpt-image-1";
            const baseName =
              String(args.name ?? "").trim() || prompt.slice(0, 32) || "Bild";
            pushActivity(
              `generiert ${n > 1 ? `${n} Bilder` : "ein Bild"}: „${prompt.slice(0, 48)}“`,
            );

            const ids = Array.from({ length: n }, () => newImageId());
            ids.forEach((id) => setImage(id, { status: "generating" }));
            addArtifact({
              title: baseName,
              kind: "image",
              content: prompt,
              imageIds: ids,
            });

            const size = resolveSize(aspect, resolution);
            const storeOne = async (id: string, i: number, b64: string) => {
              const meta = await api.imageStore(
                id,
                n > 1 ? `${baseName} ${i + 1}` : baseName,
                prompt,
                b64,
                transparent,
                size,
              );
              setImage(id, {
                status: "done",
                url: `data:image/png;base64,${b64}`,
                meta,
              });
            };

            let results: { id: string; ok: boolean; error?: string }[];
            if (useOpenAi) {
              // OpenAI: pro Bild ein Stream mit Live-Vorschau (Partial Images).
              results = await Promise.all(
                ids.map(async (id, i) => {
                  try {
                    const b64 = await generateImage(
                      key,
                      { prompt, aspect, resolution, quality, transparent, model },
                      (partial) =>
                        setImage(id, { url: `data:image/png;base64,${partial}` }),
                    );
                    await storeOne(id, i, b64);
                    return { id, ok: true };
                  } catch (e) {
                    setImage(id, { status: "error", error: String(e) });
                    return { id, ok: false, error: String(e) };
                  }
                }),
              );
            } else {
              // OpenRouter (Nano Banana): eine Anfrage, kein Partial-Streaming.
              try {
                const b64s = await generateImagesOpenRouter(key, {
                  model,
                  prompt,
                  n,
                  aspect,
                  resolution,
                });
                results = await Promise.all(
                  ids.map(async (id, i) => {
                    const b64 = b64s[i];
                    if (!b64) {
                      setImage(id, { status: "error", error: "Keine Daten." });
                      return { id, ok: false };
                    }
                    await storeOne(id, i, b64);
                    return { id, ok: true };
                  }),
                );
              } catch (e) {
                ids.forEach((id) =>
                  setImage(id, { status: "error", error: String(e) }),
                );
                results = ids.map((id) => ({ id, ok: false, error: String(e) }));
              }
            }
            const list = await api.imagesList();
            out = {
              ok: results.some((r) => r.ok),
              modell: model,
              hinweisModell: modelNote,
              images: results.map((r) => ({
                ...r,
                nummer: list.findIndex((m) => m.id === r.id) + 1 || undefined,
              })),
              hinweis:
                "Bilder sind in der Galerie. Für Änderungen edit_image mit der id aufrufen.",
            };
            break;
          }
          case "edit_image": {
            const s = settingsRefValue.current;
            const model = s?.image_model?.trim() || "gpt-image-2";
            const useOpenAi = isOpenAiImageModel(model);
            const key = useOpenAi
              ? (s?.openai_api_key?.trim() ?? "")
              : (s?.openrouter_api_key?.trim() ?? "");
            if (!key) {
              out = {
                ok: false,
                error: useOpenAi
                  ? "Kein OpenAI-API-Key hinterlegt."
                  : "Kein OpenRouter-API-Key hinterlegt (nötig für Nano Banana).",
              };
              break;
            }
            const base = await resolveImageRef(String(args.image ?? ""));
            if (!base) {
              out = {
                ok: false,
                error: `Bild „${args.image}“ nicht gefunden. Nutze list_images.`,
              };
              break;
            }
            const prompt = String(args.prompt ?? "");
            const n = Math.max(1, Math.min(8, Number(args.n) || 1));
            const quality = (
              ["low", "medium", "high", "auto"].includes(args.quality)
                ? args.quality
                : "auto"
            ) as Quality;
            let size: string | undefined;
            if (["1K", "2K", "4K"].includes(args.resolution)) {
              const aspect = (
                ["square", "landscape", "portrait", "wide"].includes(args.aspect)
                  ? args.aspect
                  : aspectFromSize(base.size)
              ) as Aspect;
              size = resolveSize(aspect, args.resolution as Resolution);
            }
            const baseName =
              String(args.name ?? "").trim() || `${base.name} (bearbeitet)`;
            pushActivity(`bearbeitet „${base.name}“: ${prompt.slice(0, 48)}`);

            const ids = Array.from({ length: n }, () => newImageId());
            ids.forEach((id) => setImage(id, { status: "generating" }));
            addArtifact({
              title: baseName,
              kind: "image",
              content: prompt,
              imageIds: ids,
            });

            try {
              const baseB64 = await api.imageReadB64(base.id);
              const editAspect = (
                ["square", "landscape", "portrait", "wide"].includes(args.aspect)
                  ? args.aspect
                  : aspectFromSize(base.size)
              ) as Aspect;
              const editedB64s = useOpenAi
                ? await editImages(key, [baseB64], {
                    prompt,
                    n,
                    quality,
                    size,
                    model,
                  })
                : await generateImagesOpenRouter(key, {
                    model,
                    prompt,
                    n,
                    aspect: editAspect,
                    resolution: (["1K", "2K", "4K"].includes(args.resolution)
                      ? args.resolution
                      : "1K") as Resolution,
                    inputRefsB64: [baseB64],
                  });
              const stored = await Promise.all(
                ids.map(async (id, i) => {
                  const b64 = editedB64s[i];
                  if (!b64) {
                    setImage(id, { status: "error", error: "Keine Daten." });
                    return { id, ok: false };
                  }
                  const meta = await api.imageStore(
                    id,
                    n > 1 ? `${baseName} ${i + 1}` : baseName,
                    prompt,
                    b64,
                    base.transparent,
                    size ?? base.size,
                  );
                  setImage(id, {
                    status: "done",
                    url: `data:image/png;base64,${b64}`,
                    meta,
                  });
                  return { id, ok: true };
                }),
              );
              const list = await api.imagesList();
              out = {
                ok: true,
                basis: base.id,
                images: stored.map((r) => ({
                  ...r,
                  nummer: list.findIndex((m) => m.id === r.id) + 1 || undefined,
                })),
              };
            } catch (e) {
              ids.forEach((id) => setImage(id, { status: "error", error: String(e) }));
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "open_image": {
            const meta = await resolveImageRef(String(args.image ?? ""));
            if (!meta) {
              out = {
                ok: false,
                error: `Bild „${args.image}“ nicht gefunden. Nutze list_images.`,
              };
              break;
            }
            if (!imagesRef.current[meta.id]) {
              setImage(meta.id, {
                status: "done",
                url: convertFileSrc(meta.path),
                meta,
              });
            }
            addArtifact({
              title: meta.name,
              kind: "image",
              content: meta.prompt,
              imageIds: [meta.id],
            });
            pushActivity(`öffnet Bild „${meta.name}“`);
            out = { ok: true, id: meta.id };
            break;
          }
          case "import_image": {
            const source = String(args.source ?? "").trim();
            if (!source) {
              out = { ok: false, error: "Keine Quelle angegeben." };
              break;
            }
            pushActivity(`importiert Bild: ${source.slice(0, 60)}`);
            try {
              const meta = await api.imageImport(
                source,
                args.name ? String(args.name) : undefined,
              );
              setImage(meta.id, {
                status: "done",
                url: convertFileSrc(meta.path),
                meta,
              });
              addArtifact({
                title: meta.name,
                kind: "image",
                content: meta.prompt,
                imageIds: [meta.id],
              });
              const list = await api.imagesList();
              out = {
                ok: true,
                id: meta.id,
                nummer: list.findIndex((m) => m.id === meta.id) + 1 || undefined,
                name: meta.name,
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "show_gallery": {
            const list = await api.imagesList();
            if (list.length === 0) {
              out = { ok: false, error: "Die Bildbibliothek ist leer." };
              break;
            }
            for (const m of list) {
              if (!imagesRef.current[m.id]) {
                setImage(m.id, {
                  status: "done",
                  url: convertFileSrc(m.path),
                  meta: m,
                });
              }
            }
            const ids = list.map((m) => m.id);
            const existing = artifactsRef.current.find(
              (a) => a.kind === "image" && a.title === "Galerie",
            );
            if (existing) {
              const next = artifactsRef.current.map((a) =>
                a.id === existing.id
                  ? { ...a, imageIds: ids, updatedAt: Date.now() }
                  : a,
              );
              commitArtifacts(next, existing.id);
              setArtifactsVisible(true);
            } else {
              addArtifact({
                title: "Galerie",
                kind: "image",
                content: "Alle gespeicherten Bilder",
                imageIds: ids,
              });
            }
            pushActivity(`zeigt die Bildbibliothek (${list.length} Bilder)`);
            out = { ok: true, anzahl: list.length };
            break;
          }
          case "list_images": {
            const list = await api.imagesList();
            out = {
              ok: true,
              images: list.map((m, i) => ({
                nummer: i + 1,
                id: m.id,
                name: m.name,
                prompt: m.prompt.slice(0, 80),
                favorit: m.favorite,
                groesse: m.size,
              })),
            };
            break;
          }
          case "manage_image": {
            const meta = await resolveImageRef(String(args.image ?? ""));
            if (!meta) {
              out = {
                ok: false,
                error: `Bild „${args.image}“ nicht gefunden. Nutze list_images.`,
              };
              break;
            }
            const action = String(args.action ?? "");
            if (action === "delete") {
              await api.imageDelete(meta.id);
              removeImageEverywhere(meta.id);
              pushActivity(`löscht Bild „${meta.name}“`);
              out = { ok: true };
            } else if (action === "rename") {
              const name = String(args.name ?? "").trim();
              if (!name) {
                out = { ok: false, error: "Kein neuer Name angegeben." };
                break;
              }
              await api.imageRename(meta.id, name);
              const st = imagesRef.current[meta.id];
              if (st?.meta) setImage(meta.id, { meta: { ...st.meta, name } });
              pushActivity(`benennt Bild um: „${name}“`);
              out = { ok: true };
            } else if (action === "favorite" || action === "unfavorite") {
              const favorite = action === "favorite";
              await api.imageFavorite(meta.id, favorite);
              const st = imagesRef.current[meta.id];
              if (st?.meta) setImage(meta.id, { meta: { ...st.meta, favorite } });
              out = { ok: true };
            } else if (action === "save") {
              const dest = args.destination ? String(args.destination) : undefined;
              const path = await api.imageExport(meta.id, dest);
              pushActivity(`speichert „${meta.name}“ → ${path}`);
              out = { ok: true, pfad: path };
            } else {
              out = { ok: false, error: `Unbekannte Aktion: ${action}` };
            }
            break;
          }
          case "get_artifact_style": {
            out = { ok: true, css: await api.readAgentFile("STYLE.css") };
            break;
          }
          case "set_artifact_style": {
            const css = String(args.css ?? "");
            if (!css.trim()) {
              out = { ok: false, error: "Leeres Stylesheet." };
              break;
            }
            await api.writeAgentFile("STYLE.css", css);
            setArtifactStyle(css);
            pushActivity("gestaltet das Artefakt-Design um");
            out = { ok: true, note: "STYLE.css ersetzt — HTML-Artefakte nutzen es sofort." };
            break;
          }
          case "remember": {
            const note = String(args.note ?? "").trim();
            if (!note) {
              out = { ok: false, error: "Leere Notiz." };
              break;
            }
            const current = await api.readAgentFile("MEMORY.md");
            const date = new Date().toISOString().slice(0, 10);
            const next = `${current.replace(/\s+$/, "")}\n- [${date}] ${note}\n`;
            await api.writeAgentFile("MEMORY.md", next);
            pushActivity("merkt sich etwas (MEMORY.md)");
            out = { ok: true };
            break;
          }
          default:
            out = { ok: false, error: `Unbekanntes Werkzeug: ${call.name}` };
        }
      } catch (e) {
        out = { ok: false, error: String(e) };
      } finally {
        flags.current.toolRunning = false;
        recompute();
      }
      clientRef.current?.sendFunctionOutput(call.callId, JSON.stringify(out));
      requestResponse();
    },
    [
      addArtifact,
      closeArtifact,
      commitArtifacts,
      newImageId,
      pushActivity,
      recompute,
      removeImageEverywhere,
      requestResponse,
      resolveImageRef,
      setImage,
    ],
  );

  // Aktuelle Settings für den Tool-Executor, ohne Callback-Neuaufbau.
  const settingsRefValue = useRef<Settings | null>(null);
  useEffect(() => {
    settingsRefValue.current = settings;
  }, [settings]);

  // ----------------------------------------------------------------
  // Verbindung
  // ----------------------------------------------------------------

  const teardown = useCallback(async () => {
    flags.current = {
      connected: false,
      connecting: false,
      userSpeaking: false,
      responseActive: false,
      playing: false,
      toolRunning: false,
    };
    levels.current = { inp: 0, out: 0 };
    setSessionStart(null);
    const engine = engineRef.current;
    engineRef.current = null;
    await engine?.stop().catch(() => {});
    recompute();
  }, [recompute]);

  const disconnect = useCallback(async () => {
    clientRef.current?.close();
    clientRef.current = null;
    await teardown();
  }, [teardown]);

  const connect = useCallback(async () => {
    setError(null);
    let current: Settings;
    try {
      current = await api.getSettings();
    } catch (e) {
      setError(String(e));
      return;
    }
    setSettings(current);
    settingsRefValue.current = current;

    if (!current.openai_api_key.trim()) {
      setError("Kein OpenAI-API-Key hinterlegt — trag ihn in den Einstellungen ein.");
      setView("settings");
      return;
    }

    flags.current.connecting = true;
    recompute();

    try {
      const engine = new AudioEngine();
      engineRef.current = engine;
      engine.onPcmChunk = (b64) => clientRef.current?.sendAudio(b64);
      engine.onInputLevel = (v) => {
        levels.current.inp = v;
      };
      engine.onOutputLevel = (v) => {
        levels.current.out = v;
      };
      engine.onDrained = () => {
        flags.current.playing = false;
        recompute();
      };
      await engine.start();

      const names = await api.listAgentFiles();
      const parts = await Promise.all(
        names.map(async (n) => `--- ${n} ---\n${await api.readAgentFile(n)}`),
      );
      // Otto soll wissen, dass die persistente Bildbibliothek existiert.
      let galleryInfo = "";
      try {
        const gallery = await api.imagesList();
        if (gallery.length > 0) {
          const recent = gallery
            .slice(-8)
            .map((m) => `Nr. ${gallery.indexOf(m) + 1} „${m.name}“ (${m.id})`)
            .join(", ");
          galleryInfo = `\n\n--- Bildbibliothek ---\nEs gibt ${gallery.length} gespeicherte Bilder aus früheren Sitzungen (persistent). Neueste: ${recent}. Zugriff über list_images, show_gallery, open_image, edit_image und manage_image.`;
        }
      } catch {
        // Ohne Galerie-Info verbinden.
      }
      const instructions = `${INSTRUCTIONS_PREAMBLE}\n\n${parts.join("\n\n")}${galleryInfo}`;

      const client = new RealtimeClient({
        onOpen: () => {
          flags.current.connecting = false;
          flags.current.connected = true;
          setSessionStart(Date.now());
          recompute();
        },
        onClose: () => {
          clientRef.current = null;
          void teardown();
        },
        onError: (msg) => setError(msg),
        onAudio: (b64) => {
          engineRef.current?.enqueue(b64);
          if (!flags.current.playing) {
            flags.current.playing = true;
            recompute();
          }
        },
        onSpeechStart: () => {
          flags.current.userSpeaking = true;
          flags.current.playing = false;
          engineRef.current?.clearPlayback();
          recompute();
        },
        onSpeechStop: () => {
          flags.current.userSpeaking = false;
          flags.current.responseActive = true; // server_vad erzeugt gleich eine Antwort
          recompute();
        },
        onResponseStart: () => {
          flags.current.responseActive = true;
          // Diese Antwort sieht alle bereits eingestellten Items — Vormerker verfällt.
          pendingCreate.current = false;
          recompute();
        },
        onResponseDone: () => {
          flags.current.responseActive = false;
          if (pendingCreate.current) {
            pendingCreate.current = false;
            clientRef.current?.createResponse();
          }
          recompute();
        },
        onUserTranscript: pushUser,
        onAssistantDelta: (itemId, delta) => upsertAssistant(itemId, delta, null),
        onAssistantDone: (itemId, text) => upsertAssistant(itemId, null, text),
        onFunctionCall: (call) => void executeTool(call),
      });
      clientRef.current = client;
      // Deaktivierte Fähigkeiten werden Otto gar nicht erst angeboten.
      const tools = toolDefs.filter((t: { name?: string }) => {
        if (t.name === "computer_use" && !current.computer_use_enabled) return false;
        if (t.name === "run_terminal" && !current.terminal_enabled) return false;
        return true;
      });
      client.connect(current.openai_api_key.trim(), {
        model: current.model,
        voice: current.voice,
        instructions,
        tools,
        reasoningEffort: current.reasoning_effort,
      });
    } catch (e) {
      const msg = String(e);
      setError(
        /NotAllowed|Permission|getUserMedia/i.test(msg)
          ? "Kein Mikrofonzugriff. Erlaube Otto das Mikrofon in den macOS-Systemeinstellungen."
          : msg,
      );
      await teardown();
    }
  }, [executeTool, pushUser, recompute, teardown, upsertAssistant]);

  useEffect(() => {
    return () => {
      clientRef.current?.close();
      engineRef.current?.stop();
    };
  }, []);

  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region>
        <span className="wordmark" data-tauri-drag-region>
          OTTO <span className="ver">v0.4.0</span>
        </span>
        <span className="titlebar-right">
          {update && (
            <button
              className="update-chip mono"
              onClick={() => void startUpdate()}
              disabled={updateProgress !== null}
              title={`Version ${update.version} herunterladen und neu starten`}
            >
              {updateProgress === null
                ? `⬆ Update ${update.version}`
                : `lädt… ${updateProgress}%`}
            </button>
          )}
          <button
            className={`panel-toggle mono ${artifactsVisible ? "on" : ""}`}
            title="Artefakt-Panel ein-/ausblenden"
            aria-label="Artefakt-Panel ein-/ausblenden"
            onClick={() => setArtifactsVisible((v) => !v)}
          >
            ▤{artifacts.length > 0 ? ` ${artifacts.length}` : ""}
          </button>
          <span className={`conn mono ${agentState}`}>{STATE_LABEL[agentState]}</span>
        </span>
      </header>

      <div className={`main ${artifactsVisible ? "artifacts-open" : ""}`}>
        <nav className="rail">
          {NAV.map((item) => (
            <button
              key={item.view}
              className={view === item.view ? "active" : ""}
              title={item.label}
              aria-label={item.label}
              onClick={() => setView(item.view)}
            >
              {item.icon}
            </button>
          ))}
        </nav>

        <section className="stage">
          {view === "talk" && (
            <VoicePanel
              state={agentState}
              transcript={transcript}
              error={error}
              sessionStart={sessionStart}
              activities={activities}
              levels={levels}
              onConnect={() => void connect()}
              onDisconnect={() => void disconnect()}
            />
          )}
          {view === "files" && <FilesPanel onStyleChanged={reloadArtifactStyle} />}
          {view === "settings" && (
            <SettingsPanel settings={settings} onSaved={setSettings} />
          )}
        </section>

        <ArtifactPanel
          artifacts={artifacts}
          activeId={activeArtifactId}
          onSelect={setActiveArtifactId}
          onClose={closeArtifact}
          artifactStyle={artifactStyle}
          images={images}
          onImageAction={handleImageAction}
        />
      </div>
    </div>
  );
}
