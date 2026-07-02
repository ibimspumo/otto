import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { AudioEngine } from "./lib/audio";
import {
  hideDrops,
  hideIsland,
  showDrops,
  showIsland,
  showSettings,
  toggleIsland,
} from "./lib/hudWindow";
import { flushSession, MEMORY_BUDGET_CHARS, runDreaming } from "./lib/memory";
import { checkForUpdate, installAndRelaunch, type Update } from "./lib/updater";
import {
  editImages,
  fetchImageModels,
  findImageModels,
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
  CliJob,
  ImageMeta,
  ImageState,
  Settings,
  TranscriptItem,
} from "./lib/types";
import Island from "./components/Island";

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
  const [agentState, setAgentState] = useState<AgentState>("disconnected");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  const [artifactStyle, setArtifactStyle] = useState("");
  // Das Drop-Fenster ist ein eigenes Fenster; hier lebt nur die Steuerung.
  // Ergebnisse erscheinen als Drop-Stapel unten links; die Quick-Look-
  // Vergrößerung orchestriert das Panel-Fenster selbst.
  const [panelOpen, setPanelOpen] = useState(false);
  const [activities, setActivities] = useState<string[]>([]);
  const [jobs, setJobs] = useState<CliJob[]>([]);
  const jobsRef = useRef<CliJob[]>([]);
  // Job-Ergebnisse, die fertig wurden, während keine Session lief.
  const pendingJobResults = useRef<string[]>([]);
  const [images, setImages] = useState<Record<string, ImageState>>({});
  const imagesRef = useRef<Record<string, ImageState>>({});
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);

  // Beim Start still auf Updates prüfen (schlägt im Dev-Modus einfach fehl).
  useEffect(() => {
    checkForUpdate().then(setUpdate);
  }, []);

  // Angezeigte Fehler: mitloggen und nach 10 s von selbst ausblenden —
  // nichts bleibt dauerhaft in der Insel kleben.
  useEffect(() => {
    if (!error) return;
    void api.logLine(`ui: ${error}`);
    const t = setTimeout(() => setError(null), 10_000);
    return () => clearTimeout(t);
  }, [error]);

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
  const panelOpenRef = useRef(false);
  const activeArtifactIdRef = useRef<string | null>(null);
  const artifactStyleRef = useRef("");
  useEffect(() => {
    panelOpenRef.current = panelOpen;
    activeArtifactIdRef.current = activeArtifactId;
    artifactStyleRef.current = artifactStyle;
  }, [panelOpen, activeArtifactId, artifactStyle]);

  /**
   * Otto zeigt etwas: Der Drop-Stapel erscheint unten links — unaufdringlich,
   * ohne Fokus-Klau, wie ein Screenshot-Thumbnail. Nie als aufspringendes
   * Programmfenster.
   */
  const openArtifacts = useCallback(() => {
    setPanelOpen(true);
  }, []);

  const closeArtifactsPanel = useCallback(() => {
    setPanelOpen(false);
  }, []);

  // Quick Look per Stimme: wirkt exakt wie ein Klick auf den Drop.
  // War das Fenster zu, wird der Wunsch vorgemerkt und nach dem
  // panel-open-Event eingelöst (sonst würde der fresh-Reset ihn schlucken).
  const pendingPresent = useRef<{ mode: "gross" | "klein"; id?: string } | null>(
    null,
  );
  const presentArtifact = useCallback((mode: "gross" | "klein", id?: string) => {
    if (mode === "klein") {
      void emit("panel-present", { mode });
      return;
    }
    if (panelOpenRef.current) {
      void emit("panel-present", { mode, id });
    } else {
      pendingPresent.current = { mode, id };
      setPanelOpen(true);
    }
  }, []);

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

  // Persistente Gesprächsprotokolle: id der laufenden SQLite-Session und
  // die finalen Transkript-Items für den Memory-Flush beim Trennen.
  const sessionIdRef = useRef<number | null>(null);
  const sessionItemsRef = useRef<TranscriptItem[]>([]);
  const dreamedRef = useRef(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        // Erststart ohne Key: direkt das Einstellungsfenster öffnen.
        if (!s.openai_api_key.trim()) {
          void showSettings("keys");
        }
      })
      .catch(() => {});
    reloadArtifactStyle();
  }, []);

  // „Dreaming“: einmal pro App-Start im Hintergrund verpasste Memory-
  // Flushes nachholen, fällige Konsolidierung fahren und aufräumen.
  useEffect(() => {
    if (!settings || dreamedRef.current) return;
    dreamedRef.current = true;
    void runDreaming(settings, pushActivity)
      .then((r) => {
        if (r.flushed > 0 || r.consolidated) {
          pushActivity("Gedächtnis auf Stand gebracht");
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  function reloadArtifactStyle() {
    api
      .readAgentFile("STYLE.css")
      .then(setArtifactStyle)
      .catch(() => setArtifactStyle(""));
  }

  const pushActivity = useCallback((text: string) => {
    setActivities((prev) => [text, ...prev].slice(0, 4));
  }, []);

  const commitJobs = useCallback((next: CliJob[]) => {
    jobsRef.current = next;
    setJobs(next);
  }, []);

  const cancelJob = useCallback(
    async (id: string) => {
      try {
        await api.cliJobCancel(id);
        pushActivity(id === "all" ? "bricht alle Jobs ab" : `bricht ${id} ab`);
      } catch (e) {
        setError(String(e));
      }
    },
    [pushActivity],
  );

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

  // Computer-Use-Schritte aus Rust in die Aktivitätsanzeige spiegeln.
  useEffect(() => {
    const un = listen<{ text: string }>("cu-status", (e) =>
      pushActivity(e.payload.text),
    );
    return () => {
      un.then((f) => f());
    };
  }, [pushActivity]);

  // Live-Output laufender Hintergrund-Jobs (delegate_task) anzeigen.
  useEffect(() => {
    const un = listen<{ job_id: string; agent: string; line: string }>(
      "cli-line",
      (e) => pushActivity(`${e.payload.agent}: ${e.payload.line.slice(0, 90)}`),
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

  // Fertige Jobs: Ergebnis in die Realtime-Session injizieren, damit Otto
  // von selbst berichtet. Ohne laufende Session wird es für die nächste
  // Verbindung vorgemerkt.
  useEffect(() => {
    const un = listen<{
      job_id: string;
      agent: string;
      task: string;
      exit_code: number | null;
      output: string;
      stderr: string;
      cancelled: boolean;
    }>("cli-done", (e) => {
      const p = e.payload;
      commitJobs(jobsRef.current.filter((j) => j.id !== p.job_id));
      if (p.cancelled) {
        pushActivity(`${p.agent}-Job abgebrochen (${p.job_id})`);
        return;
      }
      const failed = p.exit_code !== 0;
      pushActivity(
        failed
          ? `${p.agent}-Job fehlgeschlagen (${p.job_id})`
          : `${p.agent}-Job fertig (${p.job_id})`,
      );
      const message =
        `[Hintergrund-Job ${p.job_id} (${p.agent}) ist fertig — Exit-Code ${p.exit_code ?? "?"}.` +
        ` Aufgabe war: ${p.task.slice(0, 300)}]\n` +
        `Ausgabe:\n${p.output.trim() || "(leer)"}` +
        (failed && p.stderr.trim() ? `\nFehlerausgabe:\n${p.stderr.trim()}` : "") +
        `\nBerichte dem Nutzer jetzt knapp mündlich das Ergebnis; Details kannst du als Artefakt zeigen.`;
      if (clientRef.current?.connected) {
        clientRef.current.sendSystemMessage(message);
        requestResponse();
      } else {
        pendingJobResults.current.push(message);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [commitJobs, pushActivity, requestResponse]);

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
      // Otto zeigt etwas: das Panel-Fenster öffnet sich von selbst.
      openArtifacts();
      return id;
    },
    [commitArtifacts, openArtifacts],
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
      if (next.length === 0) closeArtifactsPanel();
      return true;
    },
    [closeArtifactsPanel, commitArtifacts],
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
      if (nextArts.length === 0) closeArtifactsPanel();
    },
    [closeArtifactsPanel, commitArtifacts],
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
            if (args.present) presentArtifact("gross", id);
            pushActivity(`erstellt Artefakt „${title}“`);
            out = { ok: true, id, note: "Artefakt wird angezeigt." };
            break;
          }
          case "present_artifact": {
            const mode = args.mode === "klein" ? "klein" : "gross";
            const id = args.id ? String(args.id) : undefined;
            if (id && !artifactsRef.current.some((a) => a.id === id)) {
              out = {
                ok: false,
                error: `Artefakt ${id} nicht gefunden.`,
                offene_artefakte: artifactsRef.current.map((a) => ({
                  id: a.id,
                  titel: a.title,
                  typ: a.kind,
                })),
              };
              break;
            }
            if (mode === "gross" && artifactsRef.current.length === 0) {
              out = { ok: false, error: "Es gibt gerade keine Artefakte." };
              break;
            }
            presentArtifact(mode, id);
            pushActivity(
              mode === "gross" ? "öffnet die Großansicht" : "verkleinert die Ansicht",
            );
            out = { ok: true };
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
              openArtifacts();
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
            if (visible) {
              openArtifacts();
            } else {
              setPanelOpen(false);
            }
            pushActivity(visible ? "öffnet das Artefakt-Panel" : "schließt das Artefakt-Panel");
            out = { ok: true };
            break;
          }
          case "close_artifact": {
            const id = String(args.id ?? "");
            if (id === "all") {
              commitArtifacts([]);
              setActiveArtifactId(null);
              closeArtifactsPanel();
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
              sichtbar: panelOpenRef.current,
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
              if (args.background) {
                // Non-blocking: als Hintergrund-Job über die Job-
                // Infrastruktur — Otto bleibt sofort ansprechbar.
                const jobId = await api.cliJobStart("shell", command);
                commitJobs([
                  ...jobsRef.current,
                  { id: jobId, agent: "shell", task: command },
                ]);
                out = {
                  ok: true,
                  job_id: jobId,
                  status: "gestartet",
                  hinweis:
                    "Befehl läuft im Hintergrund — das Ergebnis kommt automatisch als Systemnachricht. Abbrechen mit cancel_job.",
                };
              } else {
                const res = await api.runTerminal(
                  command,
                  typeof args.timeout_s === "number" ? args.timeout_s : undefined,
                );
                out = { ok: true, ...res };
              }
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
            // Die Insel bleibt sichtbar — sie zeigt die CU-Schritte als
            // Caption, ein eigenes Mini-Fenster braucht es nicht mehr.
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
            }
            break;
          }
          case "delegate_task": {
            const s = settingsRefValue.current;
            if (!s?.cli_enabled) {
              out = {
                ok: false,
                error: "Delegation ist in den Einstellungen deaktiviert.",
              };
              break;
            }
            const agent =
              args.agent === "codex" || args.agent === "claude"
                ? args.agent
                : s.cli_default?.trim() || "codex";
            const task = String(args.task ?? "").trim();
            if (!task) {
              out = { ok: false, error: "Leere Aufgabe." };
              break;
            }
            try {
              const jobId = await api.cliJobStart(
                agent,
                task,
                args.cwd ? String(args.cwd) : undefined,
              );
              commitJobs([...jobsRef.current, { id: jobId, agent, task }]);
              pushActivity(
                `delegiert an ${agent}: ${task.slice(0, 56)}${task.length > 56 ? "…" : ""}`,
              );
              out = {
                ok: true,
                job_id: jobId,
                agent,
                status: "gestartet",
                hinweis:
                  "Läuft im Hintergrund — du bleibst ansprechbar. Das Ergebnis kommt automatisch als Systemnachricht; sag dem Nutzer nur kurz Bescheid.",
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "cancel_job": {
            const id = String(args.job_id ?? "").trim();
            if (!id) {
              out = { ok: false, error: "Keine job_id angegeben." };
              break;
            }
            try {
              const stopped = await api.cliJobCancel(id);
              pushActivity(
                id === "all" ? "bricht alle Jobs ab" : `bricht ${id} ab`,
              );
              out = { ok: true, abgebrochen: stopped };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "generate_image": {
            const s = settingsRefValue.current;
            const transparentWanted = Boolean(args.transparent);
            // Transparenz beherrscht nur gpt-image-1 → bei Bedarf umschalten.
            let model =
              String(args.model ?? "").trim() ||
              s?.image_model?.trim() ||
              "gpt-image-2";
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

            const size = resolveSize(aspect, resolution);
            const ids = Array.from({ length: n }, () => newImageId());
            // size sofort mitgeben: Quick Look kennt so die Aspect Ratio,
            // bevor das erste Pixel da ist.
            ids.forEach((id) => setImage(id, { status: "generating", size }));
            addArtifact({
              title: baseName,
              kind: "image",
              content: prompt,
              imageIds: ids,
            });

            const storeOne = async (id: string, i: number, b64: string) => {
              const meta = await api.imageStore(
                id,
                n > 1 ? `${baseName} ${i + 1}` : baseName,
                prompt,
                b64,
                transparent,
                size,
              );
              // Nach dem Speichern die leichte asset://-URL statt der
              // Daten-URL verwenden — hält die Panel-Synchronisierung schlank.
              setImage(id, {
                status: "done",
                url: convertFileSrc(meta.path),
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
            const model =
              String(args.model ?? "").trim() ||
              s?.image_model?.trim() ||
              "gpt-image-2";
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
            ids.forEach((id) =>
              setImage(id, { status: "generating", size: size ?? base.size }),
            );
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
                    url: convertFileSrc(meta.path),
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
            const artifactId = addArtifact({
              title: meta.name,
              kind: "image",
              content: meta.prompt,
              imageIds: [meta.id],
            });
            // „Öffne das Bild“ heißt: direkt groß, nicht erst als Drop.
            presentArtifact("gross", artifactId);
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
            let galleryId: string;
            if (existing) {
              const next = artifactsRef.current.map((a) =>
                a.id === existing.id
                  ? { ...a, imageIds: ids, updatedAt: Date.now() }
                  : a,
              );
              commitArtifacts(next, existing.id);
              openArtifacts();
              galleryId = existing.id;
            } else {
              galleryId = addArtifact({
                title: "Galerie",
                kind: "image",
                content: "Alle gespeicherten Bilder",
                imageIds: ids,
              });
            }
            // Die Galerie will man durchsehen — direkt groß öffnen.
            presentArtifact("gross", galleryId);
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
            // Hartes Budget gegen Memory-Bloat: bei Überlauf muss Otto
            // erst konsolidieren (rewrite_memory), statt anzuhängen.
            if (next.length > MEMORY_BUDGET_CHARS) {
              out = {
                ok: false,
                error: `MEMORY.md ist voll (Budget ${MEMORY_BUDGET_CHARS} Zeichen). Konsolidiere zuerst mit rewrite_memory: fasse überlappende Einträge zusammen, entferne Veraltetes — und nimm die neue Notiz dabei gleich mit auf.`,
                memory_md: current,
                neue_notiz: note,
              };
              break;
            }
            await api.writeAgentFile("MEMORY.md", next);
            pushActivity("merkt sich etwas (MEMORY.md)");
            out = { ok: true };
            break;
          }
          case "rewrite_memory": {
            const content = String(args.content ?? "").trim();
            if (!content) {
              out = { ok: false, error: "Leerer Inhalt." };
              break;
            }
            if (content.length > MEMORY_BUDGET_CHARS) {
              out = {
                ok: false,
                error: `Immer noch über dem Budget (${content.length}/${MEMORY_BUDGET_CHARS} Zeichen) — kürze weiter.`,
              };
              break;
            }
            await api.writeAgentFile("MEMORY.md", `${content}\n`);
            pushActivity("konsolidiert MEMORY.md");
            out = { ok: true, zeichen: content.length };
            break;
          }
          case "search_sessions": {
            const query = String(args.query ?? "").trim();
            if (!query) {
              out = { ok: false, error: "Leere Suchanfrage." };
              break;
            }
            pushActivity(`durchsucht alte Gespräche: „${query}“`);
            const hits = await api.sessionsSearch(
              query,
              typeof args.limit === "number" ? args.limit : undefined,
            );
            out = {
              ok: true,
              treffer: hits.map((h) => ({
                datum: new Date(h.started_ms).toISOString().slice(0, 10),
                wer: h.role === "user" ? "nutzer" : "otto",
                ausschnitt: h.snippet,
              })),
              hinweis:
                hits.length === 0
                  ? "Keine Treffer — versuche andere Suchbegriffe."
                  : undefined,
            };
            break;
          }
          case "read_skill": {
            const name = String(args.name ?? "").trim();
            try {
              const content = await api.skillRead(name);
              pushActivity(`liest Skill „${name}“`);
              out = { ok: true, content };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "save_skill": {
            const name = String(args.name ?? "").trim();
            const content = String(args.content ?? "");
            try {
              await api.skillWrite(name, content);
              pushActivity(`speichert Skill „${name}“`);
              out = {
                ok: true,
                hinweis: "Skill gespeichert — er steht dir ab der nächsten Sitzung in der Skill-Liste zur Verfügung (jetzt schon via read_skill).",
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "delete_skill": {
            const name = String(args.name ?? "").trim();
            try {
              await api.skillDelete(name);
              pushActivity(`löscht Skill „${name}“`);
              out = { ok: true };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "find_image_model": {
            const query = String(args.query ?? "").trim();
            const key = settingsRefValue.current?.openrouter_api_key ?? "";
            const models = await fetchImageModels(key);
            const hits = findImageModels(models, query);
            out = {
              ok: hits.length > 0,
              modelle: hits.map((m) => ({ id: m.id, name: m.label })),
              hinweis:
                hits.length > 0
                  ? "Übergib die passende id als model an generate_image/edit_image."
                  : "Kein Modell gefunden — frag den Nutzer oder bleib beim Standard.",
            };
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
      closeArtifactsPanel,
      commitArtifacts,
      commitJobs,
      newImageId,
      openArtifacts,
      presentArtifact,
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
    // Session abschließen + Memory-Flush im Hintergrund: bleibende
    // Fakten wandern in die Tagesnotiz, die Session wird als
    // verarbeitet markiert. Blockiert den Teardown nicht.
    const sessionId = sessionIdRef.current;
    const items = sessionItemsRef.current;
    sessionIdRef.current = null;
    sessionItemsRef.current = [];
    if (sessionId !== null) {
      void api.sessionEnd(sessionId).catch(() => {});
      const s = settingsRefValue.current;
      if (s) void flushSession(s, sessionId, items);
    }
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
      void showSettings("keys");
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
      // Tagesnotizen (heute + gestern): rohe Fakten aus jüngsten
      // Gesprächen — Schicht 1 des Gedächtnisses.
      let notesInfo = "";
      if (current.memory_enabled) {
        try {
          const notes = await api.memoryNotesRecent(2);
          if (notes.trim()) {
            notesInfo = `\n\n--- Tagesnotizen (heute + gestern) ---\n${notes.trim()}`;
          }
        } catch {
          // Ohne Notizen verbinden.
        }
      }
      // Skills: nur Name + Beschreibung (Progressive Disclosure) —
      // den Body liest Otto bei Bedarf mit read_skill.
      let skillsInfo = "";
      try {
        const skills = await api.skillsList();
        if (skills.length > 0) {
          skillsInfo =
            `\n\n--- Deine Skills ---\n` +
            skills
              .map((s) => `- ${s.name}: ${s.description || "(ohne Beschreibung)"}`)
              .join("\n") +
            `\nPasst ein Skill zur Aufgabe, lies ihn ZUERST mit read_skill.`;
        }
      } catch {
        // Ohne Skill-Liste verbinden.
      }
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
      // Kontext für delegate_task: welche Agenten es gibt und wofür der
      // Nutzer sie bevorzugt (frei editierbar in den Einstellungen).
      let cliInfo = "";
      if (current.cli_enabled) {
        try {
          const avail = await api.cliAvailable();
          const status = [
            `codex ${avail.codex ? "✓ installiert" : "✗ nicht installiert"}`,
            `claude ${avail.claude ? "✓ installiert" : "✗ nicht installiert"}`,
          ].join(", ");
          cliInfo =
            `\n\n--- Delegation (delegate_task) ---\nHintergrund-Agenten auf diesem Mac: ${status}. ` +
            `Standard-Agent: ${current.cli_default?.trim() || "codex"}.`;
          if (current.cli_notes?.trim()) {
            cliInfo += `\nHinweise des Nutzers zur Wahl des Agenten: ${current.cli_notes.trim()}`;
          }
        } catch {
          // Ohne Delegations-Info verbinden.
        }
      }
      const instructions = `${INSTRUCTIONS_PREAMBLE}\n\n${parts.join("\n\n")}${notesInfo}${skillsInfo}${galleryInfo}${cliInfo}`;

      const client = new RealtimeClient({
        onOpen: () => {
          flags.current.connecting = false;
          flags.current.connected = true;
          // Protokoll der neuen Session in SQLite beginnen.
          sessionItemsRef.current = [];
          api
            .sessionStart()
            .then((id) => {
              sessionIdRef.current = id;
            })
            .catch(() => {});
          // Ergebnisse von Jobs, die ohne Session fertig wurden, nachreichen.
          if (pendingJobResults.current.length > 0) {
            for (const msg of pendingJobResults.current) {
              clientRef.current?.sendSystemMessage(msg);
            }
            pendingJobResults.current = [];
            requestResponse();
          }
          recompute();
        },
        onClose: () => {
          clientRef.current = null;
          void teardown();
        },
        onError: (msg) => setError(msg),
        // Technische Server-Fehler: nur ins interne Log (otto.log),
        // damit sie auswertbar sind, ohne den Nutzer zu behelligen.
        onLog: (msg) => void api.logLine(`realtime: ${msg}`),
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
        // Keine Text-UI mehr — Transkripte fließen nur noch ins
        // persistente Protokoll (SQLite) und in den Memory-Flush.
        onUserTranscript: (text) => {
          if (!text) return;
          sessionItemsRef.current.push({ id: "", role: "user", text, final: true });
          const sid = sessionIdRef.current;
          if (sid !== null) void api.sessionAppend(sid, "user", text).catch(() => {});
        },
        onAssistantDelta: () => {},
        onAssistantDone: (_itemId, text) => {
          if (text.trim()) {
            sessionItemsRef.current.push({
              id: "",
              role: "assistant",
              text,
              final: true,
            });
            const sid = sessionIdRef.current;
            if (sid !== null) {
              void api.sessionAppend(sid, "assistant", text).catch(() => {});
            }
          }
        },
        onFunctionCall: (call) => void executeTool(call),
      });
      clientRef.current = client;
      // Deaktivierte Fähigkeiten werden Otto gar nicht erst angeboten.
      const tools = toolDefs.filter((t: { name?: string }) => {
        if (t.name === "computer_use" && !current.computer_use_enabled) return false;
        if (t.name === "run_terminal" && !current.terminal_enabled) return false;
        if (
          (t.name === "delegate_task" || t.name === "cancel_job") &&
          !current.cli_enabled
        )
          return false;
        return true;
      });
      client.connect(current.openai_api_key.trim(), {
        model: current.model,
        voice: current.voice,
        instructions,
        tools,
        reasoningEffort: current.reasoning_effort,
        vadThreshold: current.vad_threshold,
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
  }, [executeTool, recompute, teardown]);

  useEffect(() => {
    return () => {
      clientRef.current?.close();
      engineRef.current?.stop();
    };
  }, []);

  // ----------------------------------------------------------------
  // Aktivierung: Wake Word („Hey Otto“) & globaler Hotkey
  // ----------------------------------------------------------------

  // Callbacks werden in Events/Effekten über Refs gelesen, damit keine
  // veralteten Closures hängen bleiben.
  const connectRef = useRef(connect);
  const disconnectRef = useRef(disconnect);
  useEffect(() => {
    connectRef.current = connect;
    disconnectRef.current = disconnect;
  }, [connect, disconnect]);

  const summonAndConnect = useCallback(async () => {
    if (flags.current.connected || flags.current.connecting) {
      await showIsland();
      return;
    }
    await showIsland();
    void connectRef.current();
  }, []);

  /** Dismiss: Session beenden, die Insel zieht sich in den Notch zurück. */
  const dismiss = useCallback(async () => {
    void disconnectRef.current();
    await hideIsland();
  }, []);

  // Wake-Word-Erkennung läuft offline (NSSpeechRecognizer), aber nur solange
  // keine Session aktiv ist — sonst hört Otto doppelt zu.
  const wakeActive = agentState === "disconnected";
  useEffect(() => {
    const enabled = settings?.wake_word_enabled ?? false;
    const phrase = settings?.wake_word_phrase?.trim() || "Hey Otto";
    if (enabled && wakeActive) {
      api.wakeWordStart([phrase]).catch((e) => {
        pushActivity(`Wake Word nicht verfügbar: ${String(e).slice(0, 80)}`);
      });
    } else {
      api.wakeWordStop().catch(() => {});
    }
    return () => {
      api.wakeWordStop().catch(() => {});
    };
  }, [
    settings?.wake_word_enabled,
    settings?.wake_word_phrase,
    wakeActive,
    pushActivity,
  ]);

  useEffect(() => {
    const un = listen("wake-word", () => {
      void summonAndConnect();
    });
    return () => {
      un.then((f) => f());
    };
  }, [summonAndConnect]);

  // Globaler Hotkey: verbindet (und holt die Insel nach vorn) bzw. trennt.
  // Spezialfall „2x Cmd“: Modifier-only-Taps kann das Shortcut-Plugin nicht —
  // dafür läuft ein nativer NSEvent-Monitor in Rust (Event "double-cmd").
  const isDoubleCmd = (combo: string) =>
    /^(2x ?cmd|cmd ?cmd|doppel[- ]?cmd|double[- ]?cmd|⌘⌘)$/i.test(combo);
  useEffect(() => {
    if (!settings) return;
    let disposed = false;
    (async () => {
      await unregisterAll().catch(() => {});
      await api.dblcmdStop().catch(() => {});
      const combo = settings.hotkey?.trim();
      if (!settings.hotkey_enabled || !combo || disposed) return;
      if (isDoubleCmd(combo)) {
        await api.dblcmdStart().catch((e) => {
          setError(
            `Doppel-Cmd ließ sich nicht aktivieren: ${String(e)} — braucht die Bedienungshilfen-Freigabe.`,
          );
        });
        return;
      }
      try {
        await register(combo, (event) => {
          if (event.state !== "Pressed") return;
          if (flags.current.connected || flags.current.connecting) {
            void dismiss();
          } else {
            void summonAndConnect();
          }
        });
      } catch (e) {
        setError(`Hotkey „${combo}“ ließ sich nicht registrieren: ${String(e)}`);
      }
    })();
    return () => {
      disposed = true;
      void unregisterAll().catch(() => {});
      void api.dblcmdStop().catch(() => {});
    };
  }, [settings, settings?.hotkey, settings?.hotkey_enabled, summonAndConnect, dismiss]);

  // Doppel-Cmd aus dem nativen Monitor: gleiche Wirkung wie der Hotkey.
  useEffect(() => {
    const un = listen("double-cmd", () => {
      if (flags.current.connected || flags.current.connecting) {
        void dismiss();
      } else {
        void summonAndConnect();
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [dismiss, summonAndConnect]);

  // Tray-Icon: Linksklick toggelt die Insel, Menüpunkte öffnen gezielt.
  useEffect(() => {
    const unToggle = listen("tray-toggle", () => {
      void toggleIsland();
    });
    const unConnect = listen("tray-connect", () => {
      void summonAndConnect();
    });
    const unSettings = listen("tray-settings", () => void showSettings("allgemein"));
    const unFiles = listen("tray-files", () => void showSettings("persona"));
    return () => {
      unToggle.then((f) => f());
      unConnect.then((f) => f());
      unSettings.then((f) => f());
      unFiles.then((f) => f());
    };
  }, [summonAndConnect]);

  // Escape = Dismiss: Session beenden, Orb verschwindet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  // ----------------------------------------------------------------
  // Drop-Fenster: Sichtbarkeit steuern und Zustand hinüberspiegeln
  // ----------------------------------------------------------------

  const panelWasOpen = useRef(false);
  useEffect(() => {
    if (panelOpen) {
      void showDrops();
      // fresh = das Fenster war zu: das Panel setzt sich in den
      // Stapel-Modus zurück, statt eine alte Quick-Look-Ansicht zu zeigen.
      void emit("panel-open", { fresh: !panelWasOpen.current });
      // Vorgemerkter Quick-Look-Wunsch (present_artifact bei zuem Fenster):
      // NACH panel-open senden, damit der fresh-Reset ihn nicht überschreibt.
      if (pendingPresent.current) {
        void emit("panel-present", pendingPresent.current);
        pendingPresent.current = null;
      }
    } else {
      void hideDrops();
    }
    panelWasOpen.current = panelOpen;
  }, [panelOpen]);

  // Artefakte, Bilder und Stil live ans Panel-Fenster spiegeln.
  useEffect(() => {
    void emit("panel-state", {
      artifacts,
      activeId: activeArtifactId,
      images,
      artifactStyle,
    });
  }, [artifacts, activeArtifactId, images, artifactStyle]);

  // Aktionen aus dem Panel-Fenster (Tab-Wechsel, Schließen, Bild-Aktionen).
  useEffect(() => {
    const unReady = listen("panel-ready", () => {
      void emit("panel-state", {
        artifacts: artifactsRef.current,
        activeId: activeArtifactIdRef.current,
        images: imagesRef.current,
        artifactStyle: artifactStyleRef.current,
      });
    });
    const unClose = listen("panel-close", () => setPanelOpen(false));
    const unAction = listen<{
      type: "select" | "close" | "image";
      id?: string;
      action?: "favorite" | "delete" | "save";
    }>("panel-action", (e) => {
      const p = e.payload;
      if (p.type === "select" && p.id) {
        setActiveArtifactId(p.id);
      } else if (p.type === "close" && p.id) {
        closeArtifact(p.id);
      } else if (p.type === "image" && p.id && p.action) {
        void handleImageAction(p.id, p.action);
      }
    });
    const unStyle = listen("style-changed", () => reloadArtifactStyle());
    const unSettings = listen("settings-changed", () => {
      api.getSettings().then(setSettings).catch(() => {});
    });
    return () => {
      unReady.then((f) => f());
      unClose.then((f) => f());
      unAction.then((f) => f());
      unStyle.then((f) => f());
      unSettings.then((f) => f());
    };
  }, [closeArtifact, handleImageAction]);

  /** Insel-Button: Drop-Stapel zeigen bzw. verbergen. */
  const toggleArtifactsWindow = useCallback(() => {
    setPanelOpen((open) => !open);
  }, []);

  return (
    <Island
      state={agentState}
      error={error}
      activities={activities}
      jobs={jobs}
      onCancelJob={(id) => void cancelJob(id)}
      levels={levels}
      onConnect={() => void connect()}
      onDisconnect={() => void disconnect()}
      artifactCount={artifacts.length}
      panelOpen={panelOpen}
      onToggleArtifacts={toggleArtifactsWindow}
      onDismiss={() => void dismiss()}
      onOpenSettings={() => void showSettings("allgemein")}
      update={update}
      updateProgress={updateProgress}
      onUpdate={() => void startUpdate()}
    />
  );
}
