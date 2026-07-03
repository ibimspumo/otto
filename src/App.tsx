import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioEngine } from "./lib/audio";
import { showSettings } from "./lib/hudWindow";
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
import { prepareImageForRealtime } from "./lib/vision";
import { analyzeDocument } from "./lib/docs";
import { cancelResearch, pollResearch, startResearch } from "./lib/research";
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
import { useActivation } from "./hooks/useActivation";
import { usePanelSync } from "./hooks/usePanelSync";

/**
 * Fischt Bilddatei-Pfade aus der Ausgabe eines CLI-Jobs — Basis für den
 * Auto-Import erzeugter Bilder in die Galerie. Erkennt Pfade als eigene
 * Zeile (auch mit Leerzeichen im Namen) und Pfade mitten im Fließtext.
 */
function extractImagePaths(text: string, max = 12): string[] {
  const lineRe = /^(?:~\/|\/)[^"'`]*\.(?:png|jpe?g|webp|gif|heic)$/i;
  const inlineRe = /(?:~\/|\/)[^\s"'`()<>]+\.(?:png|jpe?g|webp|gif|heic)/gi;
  const found = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s+/, "");
    if (lineRe.test(line)) {
      found.add(line);
      continue;
    }
    for (const m of line.matchAll(inlineRe)) found.add(m[0]);
  }
  return [...found].slice(0, max);
}

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
  // Die eine Zeile "was Otto GERADE tut" — kein Log: wird beim Ende der
  // Aktion (Tool fertig, Antwort fertig) gelöscht und verfällt sonst nach
  // kurzer Zeit von selbst, damit nie veralteter Status kleben bleibt.
  const [activity, setActivity] = useState<string | null>(null);
  const activityTs = useRef(0);
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
  type PresentMode = "gross" | "riesig" | "klein";
  const pendingPresent = useRef<{ mode: PresentMode; id?: string } | null>(
    null,
  );
  const presentArtifact = useCallback((mode: PresentMode, id?: string) => {
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
    // Zähler statt Boolean: Das Modell kann mehrere Function-Calls in einer
    // Antwort liefern — ein Boolean würde beim ersten fertigen Tool kippen.
    toolRunning: 0,
  });
  // Watchdog gegen hängendes "denkt": onSpeechStop setzt responseActive
  // spekulativ; kommt der Server nie mit response.created, räumt der Timer auf.
  const speculativeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persistente Gesprächsprotokolle: id der laufenden SQLite-Session und
  // die finalen Transkript-Items für den Memory-Flush beim Trennen.
  const sessionIdRef = useRef<number | null>(null);
  const sessionItemsRef = useRef<TranscriptItem[]>([]);
  const dreamedRef = useRef(false);
  const lastFlushRef = useRef<Promise<void> | null>(null);

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
      .catch((e) => void api.logLine(`settings load failed: ${String(e)}`));
    reloadArtifactStyle();
  }, []);

  // App-Identität prüfen: läuft Otto aus einer translozierten Kopie, merkt
  // sich macOS keine Freigaben — ein deutlicher Hinweis mit Handlungsempfehlung.
  useEffect(() => {
    api
      .appDiagnostics()
      .then((d) => {
        if (d.translocated) {
          setError(
            "Otto läuft aus einer Kopie ohne feste Identität (App Translocation). Verschiebe Otto per Finder in „Programme“, entferne die Quarantäne und starte neu — sonst merkt sich macOS keine Freigaben. Details unter Einstellungen → Diagnose.",
          );
        }
      })
      .catch((e) => void api.logLine(`diagnostics failed: ${String(e)}`));
  }, []);

  // „Dreaming“: beim App-Start UND danach stündlich — eine Menüleisten-App
  // läuft wochenlang ohne Neustart; ein Einmal-Lauf hieße: Konsolidierung,
  // Catch-up und Cleanup passieren faktisch nie. runDreaming selbst prüft
  // die 20-h-Fälligkeit, der Timer ist also billig.
  const dreamingBusyRef = useRef(false);
  useEffect(() => {
    if (!settings || dreamedRef.current) return;
    dreamedRef.current = true;
    const dream = async () => {
      const s = settingsRefValue.current;
      if (!s || dreamingBusyRef.current) return;
      dreamingBusyRef.current = true;
      try {
        const r = await runDreaming(s, pushActivity);
        if (r.flushed > 0 || r.consolidated) {
          pushActivity("Gedächtnis auf Stand gebracht");
        }
      } catch (e) {
        void api.logLine(`dreaming failed: ${String(e)}`);
      } finally {
        dreamingBusyRef.current = false;
      }
    };
    void dream();
    const timer = setInterval(() => void dream(), 60 * 60 * 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  function reloadArtifactStyle() {
    api
      .readAgentFile("STYLE.css")
      .then(setArtifactStyle)
      .catch(() => setArtifactStyle(""));
  }

  const pushActivity = useCallback((text: string) => {
    activityTs.current = Date.now();
    setActivity(text);
  }, []);

  const clearActivity = useCallback(() => {
    activityTs.current = Date.now();
    setActivity(null);
  }, []);

  // Verfallsdatum: Ohne laufendes Tool verschwindet der Status nach 8 s
  // von selbst (Job-Zeilen, Notifications). Läuft noch ein Tool, bleibt
  // er stehen und der Timer prüft erneut.
  useEffect(() => {
    if (!activity) return;
    const ts = activityTs.current;
    const tick = () => {
      if (activityTs.current !== ts) return; // längst überschrieben
      if (flags.current.toolRunning > 0) {
        timer = setTimeout(tick, 4_000);
        return;
      }
      setActivity(null);
    };
    let timer = setTimeout(tick, 8_000);
    return () => clearTimeout(timer);
  }, [activity]);

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
      .catch((e) => void api.logLine(`images list failed: ${String(e)}`));
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

  // (Die cli-line/cli-done-Listener leben weiter unten — sie brauchen die
  // Job-Artefakt-Helfer, die erst nach dem Artefakt-Block definiert sind.)

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
    else if (f.responseActive || f.toolRunning > 0) next = "thinking";
    else next = "idle";
    setAgentState(next);
  }, []);

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

  // ---- Gläserne Jobs: jeder Hintergrund-Job ist ein lebendes Artefakt ----

  /** Legt das Live-Terminal-Artefakt für einen frisch gestarteten Job an. */
  const addJobArtifact = useCallback(
    (jobId: string, agent: string, task: string): string => {
      return addArtifact({
        title: `${agent}: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`,
        kind: "job",
        content: task,
        jobId,
        jobAgent: agent,
        jobStatus: "running",
        jobLines: [],
      });
    },
    [addArtifact],
  );

  const patchJobArtifact = useCallback(
    (jobId: string, patch: Partial<Artifact>) => {
      const idx = artifactsRef.current.findIndex(
        (a) => a.kind === "job" && a.jobId === jobId,
      );
      if (idx < 0) return;
      const next = [...artifactsRef.current];
      next[idx] = { ...next[idx], ...patch, updatedAt: Date.now() };
      commitArtifacts(next);
    },
    [commitArtifacts],
  );

  const appendJobLine = useCallback(
    (jobId: string, line: string) => {
      const idx = artifactsRef.current.findIndex(
        (a) => a.kind === "job" && a.jobId === jobId,
      );
      if (idx < 0) return;
      const a = artifactsRef.current[idx];
      patchJobArtifact(jobId, {
        jobLines: [...(a.jobLines ?? []), line].slice(-400),
      });
    },
    [patchJobArtifact],
  );

  // Laufende Deep-Research-Jobs: job_id → Responses-API-id (fürs Abbrechen).
  const researchJobsRef = useRef<Map<string, string>>(new Map());

  /**
   * Beobachtet einen Background-Research-Lauf: pollt die Responses API,
   * hält das Job-Artefakt lebendig und liefert das Dossier wie ein
   * Job-Ergebnis in die Session (oder in pendingJobResults).
   */
  const runResearchWatcher = useCallback(
    (jobId: string, responseId: string, frage: string, apiKey: string) => {
      const started = Date.now();
      const deliver = (message: string) => {
        if (clientRef.current?.connected) {
          clientRef.current.sendSystemMessage(message);
          requestResponse();
        } else {
          pendingJobResults.current.push(message);
        }
      };
      const tick = async () => {
        if (!researchJobsRef.current.has(jobId)) return; // abgebrochen
        try {
          const st = await pollResearch(apiKey, responseId);
          if (st.status === "completed") {
            researchJobsRef.current.delete(jobId);
            patchJobArtifact(jobId, { jobStatus: "done", exitCode: 0 });
            appendJobLine(jobId, "✓ Recherche abgeschlossen");
            pushActivity("Recherche fertig");
            deliver(
              `[Hintergrund-Recherche ${jobId} ist fertig. Frage war: ${frage.slice(0, 300)}]\n` +
                `Dossier:\n${st.text || "(leer)"}\n` +
                `Erstelle jetzt ein Markdown-Artefakt (create_artifact, present=true) mit dem aufbereiteten Dossier inkl. Quellen und fasse mündlich knapp zusammen.`,
            );
            return;
          }
          if (st.status === "failed" || st.status === "cancelled" || st.error) {
            researchJobsRef.current.delete(jobId);
            patchJobArtifact(jobId, {
              jobStatus: st.status === "cancelled" ? "cancelled" : "error",
            });
            appendJobLine(jobId, `✗ ${st.error ?? st.status}`);
            deliver(
              `[Hintergrund-Recherche ${jobId} ist fehlgeschlagen: ${st.error ?? st.status}. Sag dem Nutzer kurz Bescheid.]`,
            );
            return;
          }
          appendJobLine(
            jobId,
            `… recherchiert (${st.status}, ${Math.max(1, Math.round((Date.now() - started) / 60_000))} min)`,
          );
        } catch (e) {
          appendJobLine(jobId, `Status-Check fehlgeschlagen: ${String(e)}`);
        }
        if (Date.now() - started > 30 * 60_000) {
          researchJobsRef.current.delete(jobId);
          void cancelResearch(apiKey, responseId);
          patchJobArtifact(jobId, { jobStatus: "error" });
          appendJobLine(jobId, "✗ Timeout nach 30 min — abgebrochen");
          deliver(`[Hintergrund-Recherche ${jobId} nach 30 min abgebrochen (Timeout).]`);
          return;
        }
        setTimeout(() => void tick(), 20_000);
      };
      setTimeout(() => void tick(), 15_000);
    },
    [appendJobLine, patchJobArtifact, pushActivity, requestResponse],
  );

  // Live-Output laufender Hintergrund-Jobs: Zeile in die Insel-Caption
  // UND ins Live-Terminal des Job-Artefakts.
  useEffect(() => {
    const un = listen<{ job_id: string; agent: string; line: string }>(
      "cli-line",
      (e) => {
        pushActivity(`${e.payload.agent}: ${e.payload.line.slice(0, 90)}`);
        appendJobLine(e.payload.job_id, e.payload.line);
      },
    );
    return () => {
      un.then((f) => f());
    };
  }, [appendJobLine, pushActivity]);

  // Fertige Jobs: Ergebnis in die Realtime-Session injizieren, damit Otto
  // von selbst berichtet. Ohne laufende Session wird es für die nächste
  // Verbindung vorgemerkt. Das Job-Artefakt morpht in seinen Endzustand.
  useEffect(() => {
    const un = listen<{
      job_id: string;
      agent: string;
      task: string;
      exit_code: number | null;
      output: string;
      stderr: string;
      cancelled: boolean;
    }>("cli-done", async (e) => {
      const p = e.payload;
      const job = jobsRef.current.find((j) => j.id === p.job_id);
      commitJobs(jobsRef.current.filter((j) => j.id !== p.job_id));
      if (p.cancelled) {
        patchJobArtifact(p.job_id, { jobStatus: "cancelled", exitCode: p.exit_code });
        pushActivity(`${p.agent}-Job abgebrochen (${p.job_id})`);
        return;
      }
      const failed = p.exit_code !== 0;
      patchJobArtifact(p.job_id, {
        jobStatus: failed ? "error" : "done",
        exitCode: p.exit_code,
      });
      pushActivity(
        failed
          ? `${p.agent}-Job fehlgeschlagen (${p.job_id})`
          : `${p.agent}-Job fertig (${p.job_id})`,
      );
      // Hat der Agent Bilddateien erzeugt, landen sie automatisch in der
      // Galerie: Pfade aus der Ausgabe fischen und importieren. Der mtime-
      // Guard (Job-Start minus Slack) hält bloß erwähnte Alt-Bilder draußen.
      let galleryNote = "";
      if (!failed && (p.agent === "codex" || p.agent === "claude")) {
        const imported: string[] = [];
        for (const path of extractImagePaths(p.output)) {
          try {
            const meta = await api.imageImport(
              path,
              undefined,
              job?.startedAt ? job.startedAt - 30_000 : undefined,
            );
            setImage(meta.id, {
              status: "done",
              url: convertFileSrc(meta.path),
              meta,
            });
            imported.push(`${meta.name} (id ${meta.id})`);
          } catch (err) {
            void api.logLine(`auto-import übersprungen (${path}): ${String(err)}`);
          }
        }
        if (imported.length > 0) {
          pushActivity(
            imported.length === 1
              ? "1 Bild in die Galerie importiert"
              : `${imported.length} Bilder in die Galerie importiert`,
          );
          galleryNote =
            `\nDie erzeugten Bilder wurden automatisch in die Galerie importiert: ` +
            `${imported.join(", ")}. Zeig sie dem Nutzer mit open_image (einzeln) oder show_gallery.`;
        }
      }
      const message =
        `[Hintergrund-Job ${p.job_id} (${p.agent}) ist fertig — Exit-Code ${p.exit_code ?? "?"}.` +
        ` Aufgabe war: ${p.task.slice(0, 300)}]\n` +
        `Ausgabe:\n${p.output.trim() || "(leer)"}` +
        (failed && p.stderr.trim() ? `\nFehlerausgabe:\n${p.stderr.trim()}` : "") +
        galleryNote +
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
  }, [commitJobs, patchJobArtifact, pushActivity, requestResponse, setImage]);

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
      flags.current.toolRunning += 1;
      recompute();
      const args = call.args as Record<string, any>;
      let out: object;
      try {
        switch (call.name) {
          case "create_artifact": {
            const kind: ArtifactKind = ["markdown", "code"].includes(args.kind)
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
            const mode =
              args.mode === "klein"
                ? "klein"
                : args.mode === "riesig"
                  ? "riesig"
                  : "gross";
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
            if (mode !== "klein" && artifactsRef.current.length === 0) {
              out = { ok: false, error: "Es gibt gerade keine Artefakte." };
              break;
            }
            presentArtifact(mode, id);
            pushActivity(
              mode === "klein"
                ? "verkleinert die Ansicht"
                : mode === "riesig"
                  ? "öffnet die Lightbox"
                  : "öffnet die Großansicht",
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
            const searchType = ["news", "images", "videos"].includes(args.type)
              ? (args.type as string)
              : "web";
            const typeLabel: Record<string, string> = {
              web: "das Web",
              news: "aktuelle News",
              images: "Web-Bilder",
              videos: "Videos",
            };
            pushActivity(`durchsucht ${typeLabel[searchType]}: „${query}“`);
            const res = await api.braveSearch(
              query,
              key,
              typeof args.count === "number" ? args.count : undefined,
              searchType,
            );
            let artifactId: string | undefined;
            // Bilder- und Video-Treffer leben von der Vorschau — die
            // Quellenfläche ist hier die sinnvolle Standard-Ausgabe.
            if (args.show_results === true || searchType === "images" || searchType === "videos") {
              artifactId = addArtifact({
                title:
                  searchType === "web"
                    ? `Recherchequellen: ${res.query}`
                    : `${typeLabel[searchType]}: ${res.query}`,
                kind: "search",
                content: res.query,
                results: res.results,
              });
              presentArtifact("gross", artifactId);
            }
            out = {
              ok: true,
              query: res.query,
              type: searchType,
              results: res.results,
              artifact_id: artifactId,
              next_step:
                searchType === "images" || searchType === "videos"
                  ? "Die Treffer werden dem Nutzer bereits visuell gezeigt — fasse mündlich knapp zusammen."
                  : "Erstelle jetzt ein Markdown-Artefakt mit create_artifact(kind=\"markdown\", present=true), das die Recherche auswertet, strukturiert und Quellen verlinkt. Nutze Tabellen, klare Abschnitte und bei Bedarf Mermaid-Diagramme.",
            };
            break;
          }
          case "toggle_artifact_panel": {
            const visible = Boolean(args.visible);
            if (visible) {
              // Ein leeres Panel wäre nur ein unsichtbares Fenster, das
              // Klicks frisst — gar nicht erst öffnen.
              if (artifactsRef.current.length === 0) {
                out = { ok: false, error: "Keine offenen Artefakte — nichts anzuzeigen." };
                break;
              }
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
                  { id: jobId, agent: "shell", task: command, startedAt: Date.now() },
                ]);
                addJobArtifact(jobId, "shell", command);
                out = {
                  ok: true,
                  job_id: jobId,
                  status: "gestartet",
                  hinweis:
                    "Befehl läuft im Hintergrund — das Ergebnis kommt automatisch als Systemnachricht. Der Nutzer sieht ein Live-Terminal als Drop. Zwischenstand: read_job_output; groß zeigen: show_job; abbrechen: cancel_job.",
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
              commitJobs([
                ...jobsRef.current,
                { id: jobId, agent, task, startedAt: Date.now() },
              ]);
              addJobArtifact(jobId, agent, task);
              pushActivity(
                `delegiert an ${agent}: ${task.slice(0, 56)}${task.length > 56 ? "…" : ""}`,
              );
              out = {
                ok: true,
                job_id: jobId,
                agent,
                status: "gestartet",
                hinweis:
                  "Läuft im Hintergrund — du bleibst ansprechbar. Das Ergebnis kommt automatisch als Systemnachricht; sag dem Nutzer nur kurz Bescheid. Der Nutzer sieht ein Live-Terminal als Drop. Zwischenstand: read_job_output; groß zeigen: show_job.",
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
              // Research-Jobs laufen nicht über cli.rs — separat abbrechen.
              const researchIds =
                id === "all"
                  ? [...researchJobsRef.current.keys()]
                  : researchJobsRef.current.has(id)
                    ? [id]
                    : [];
              const oaKey = settingsRefValue.current?.openai_api_key?.trim() ?? "";
              for (const jid of researchIds) {
                const rid = researchJobsRef.current.get(jid);
                researchJobsRef.current.delete(jid);
                if (rid && oaKey) void cancelResearch(oaKey, rid);
                patchJobArtifact(jid, { jobStatus: "cancelled" });
              }
              let stoppedCli: string[] = [];
              if (id === "all" || researchIds.length === 0) {
                stoppedCli = await api.cliJobCancel(id).catch(() => []);
              }
              pushActivity(
                id === "all" ? "bricht alle Jobs ab" : `bricht ${id} ab`,
              );
              out = {
                ok: true,
                abgebrochen: [...researchIds, ...stoppedCli],
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "read_document": {
            const key = settingsRefValue.current?.openrouter_api_key?.trim() ?? "";
            if (!key) {
              out = {
                ok: false,
                error:
                  "Kein OpenRouter-API-Key hinterlegt (nötig für Dokument-Analyse).",
              };
              break;
            }
            const source = String(args.source ?? "").trim();
            if (!source) {
              out = { ok: false, error: "Keine Quelle angegeben." };
              break;
            }
            try {
              const filename = source.split("/").pop() || "dokument.pdf";
              pushActivity(`liest ${filename}`);
              const isUrl = /^https?:\/\//.test(source);
              const file = isUrl
                ? { url: source, filename }
                : {
                    dataUrl: `data:application/pdf;base64,${await api.fileReadB64(source)}`,
                    filename,
                  };
              const answer = await analyzeDocument(
                key,
                file,
                String(args.frage ?? ""),
              );
              out = {
                ok: true,
                dokument: filename,
                antwort: answer,
                next_step:
                  "Zeig das Ergebnis jetzt als Markdown-Artefakt (create_artifact, present=true) und fasse mündlich knapp zusammen.",
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "research_task": {
            const key = settingsRefValue.current?.openai_api_key?.trim() ?? "";
            if (!key) {
              out = { ok: false, error: "Kein OpenAI-API-Key hinterlegt." };
              break;
            }
            const frage = String(args.frage ?? "").trim();
            if (!frage) {
              out = { ok: false, error: "Keine Recherche-Frage angegeben." };
              break;
            }
            try {
              const responseId = await startResearch(key, frage);
              const jobId = `research-${++seq.current}`;
              researchJobsRef.current.set(jobId, responseId);
              addJobArtifact(jobId, "research", frage);
              appendJobLine(jobId, "Deep-Research gestartet — recherchiert im Web…");
              pushActivity(`recherchiert gründlich: „${frage.slice(0, 48)}“`);
              runResearchWatcher(jobId, responseId, frage, key);
              out = {
                ok: true,
                job_id: jobId,
                status: "gestartet",
                hinweis:
                  "Läuft einige Minuten im Hintergrund — das Dossier kommt automatisch als Systemnachricht; sag dem Nutzer nur kurz Bescheid. Zwischenstand: read_job_output.",
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "screen_context": {
            try {
              const ctx = await api.screenContext();
              pushActivity("schaut, wo du gerade bist");
              out = {
                ok: true,
                app: ctx.app_name,
                bundle_id: ctx.bundle_id,
                fenster_titel: ctx.window_title,
                markierter_text: ctx.selected_text,
                maus_display: ctx.mouse_display,
                displays: ctx.display_count,
                hinweis: ctx.accessibility
                  ? undefined
                  : "Bedienungshilfen-Freigabe fehlt — Fenstertitel und markierter Text sind deshalb nicht lesbar (Einstellungen → Diagnose).",
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "look_at_screen": {
            try {
              const clip = await api.clipboardImage();
              if (!clip) {
                out = {
                  ok: false,
                  error:
                    "Kein Bild in der Zwischenablage. Bitte den Nutzer, ⌘⇧⌃4 zu drücken und den Bereich aufzuziehen (landet in der Zwischenablage) — dann rufst du look_at_screen erneut auf.",
                };
                break;
              }
              pushActivity("schaut auf deinen Bildschirm");
              const prepared = await prepareImageForRealtime(clip.b64, clip.format);
              clientRef.current?.sendImage(
                prepared.dataUrl,
                String(args.frage ?? "").trim() ||
                  "Das ist ein aktueller Screenshot vom Bildschirm des Nutzers.",
              );
              out = {
                ok: true,
                hinweis: `Screenshot (${prepared.width}×${prepared.height}) liegt jetzt als Bild in der Konversation — beschreibe/analysiere ihn direkt in deiner Antwort.`,
              };
            } catch (e) {
              out = { ok: false, error: String(e) };
            }
            break;
          }
          case "read_job_output": {
            const id = String(args.job_id ?? "").trim();
            const jobArts = artifactsRef.current.filter((a) => a.kind === "job");
            const art = id
              ? jobArts.find((a) => a.jobId === id)
              : jobArts[jobArts.length - 1];
            if (!art) {
              out = {
                ok: false,
                error: id
                  ? `Kein Job-Artefakt zu ${id} gefunden.`
                  : "Kein Hintergrund-Job vorhanden.",
                jobs: jobArts.map((a) => ({ job_id: a.jobId, status: a.jobStatus })),
              };
              break;
            }
            const wanted = Math.max(5, Math.min(200, Number(args.lines) || 40));
            out = {
              ok: true,
              job_id: art.jobId,
              agent: art.jobAgent,
              status: art.jobStatus,
              exit_code: art.exitCode ?? null,
              aufgabe: art.content.slice(0, 300),
              letzte_zeilen: (art.jobLines ?? []).slice(-wanted),
            };
            break;
          }
          case "show_job": {
            const id = String(args.job_id ?? "").trim();
            const jobArts = artifactsRef.current.filter((a) => a.kind === "job");
            const art = id
              ? jobArts.find((a) => a.jobId === id)
              : jobArts[jobArts.length - 1];
            if (!art) {
              out = {
                ok: false,
                error: id
                  ? `Kein Job-Artefakt zu ${id} gefunden.`
                  : "Kein Hintergrund-Job vorhanden.",
              };
              break;
            }
            presentArtifact("gross", art.id);
            pushActivity(`holt ${art.jobAgent}-Job nach vorn`);
            out = { ok: true, job_id: art.jobId, status: art.jobStatus };
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
                markdown: `![${m.name}](otto-image:${m.id})`,
              })),
              note:
                "Galerie-Bilder können in Markdown-Artefakten direkt mit ![Name](otto-image:<id>) eingebettet werden.",
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
        flags.current.toolRunning = Math.max(0, flags.current.toolRunning - 1);
        // Letztes Tool fertig → der Live-Status gehört gelöscht, sonst
        // zeigt die nächste Denkphase eine längst beendete Tätigkeit.
        if (flags.current.toolRunning === 0) clearActivity();
        recompute();
      }
      clientRef.current?.sendFunctionOutput(call.callId, JSON.stringify(out));
      requestResponse();
    },
    [
      addArtifact,
      addJobArtifact,
      appendJobLine,
      clearActivity,
      closeArtifact,
      closeArtifactsPanel,
      commitArtifacts,
      commitJobs,
      newImageId,
      openArtifacts,
      presentArtifact,
      patchJobArtifact,
      pushActivity,
      recompute,
      removeImageEverywhere,
      requestResponse,
      resolveImageRef,
      runResearchWatcher,
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
      toolRunning: 0,
    };
    if (speculativeTimer.current) {
      clearTimeout(speculativeTimer.current);
      speculativeTimer.current = null;
    }
    clearActivity();
    levels.current = { inp: 0, out: 0 };
    // Session abschließen + Memory-Flush im Hintergrund: bleibende
    // Fakten wandern in die Tagesnotiz, die Session wird als
    // verarbeitet markiert. Blockiert den Teardown nicht.
    const sessionId = sessionIdRef.current;
    const items = sessionItemsRef.current;
    sessionIdRef.current = null;
    sessionItemsRef.current = [];
    if (sessionId !== null) {
      void api.sessionEnd(sessionId).catch((e) =>
        api.logLine(`session end failed: ${String(e)}`),
      );
      const s = settingsRefValue.current;
      if (s) {
        // Promise merken: Beim Quit übers Tray wird darauf (begrenzt)
        // gewartet, damit der letzte Memory-Flush nicht verloren geht.
        lastFlushRef.current = flushSession(s, sessionId, items);
      }
    }
    const engine = engineRef.current;
    engineRef.current = null;
    await engine?.stop().catch((e) => void api.logLine(`audio stop failed: ${String(e)}`));
    recompute();
  }, [clearActivity, recompute]);

  const disconnect = useCallback(async () => {
    clientRef.current?.close();
    clientRef.current = null;
    await teardown();
  }, [teardown]);

  // Quit übers Tray: erst sauber trennen (session_end + Flush anstoßen),
  // den Flush begrenzt abwarten, dann Rust beenden lassen. Der Tray hat
  // einen 8-s-Fallback, falls hier etwas hängt.
  useEffect(() => {
    const un = listen("app-quit", async () => {
      try {
        await disconnect();
        await Promise.race([
          lastFlushRef.current ?? Promise.resolve(),
          new Promise((r) => setTimeout(r, 5_000)),
        ]);
      } catch (e) {
        void api.logLine(`quit teardown failed: ${String(e)}`);
      } finally {
        void api.appExit().catch(() => {});
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [disconnect]);

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
      // YOLO-Modus: Otto muss wissen, dass die üblichen Terminal-Schranken
      // aufgehoben sind — sonst versucht er destruktive Befehle gar nicht erst.
      const yoloInfo = current.yolo_mode
        ? `\n\n--- YOLO-Modus AKTIV ---\nDer Nutzer hat den vollen Systemzugriff freigeschaltet. run_terminal und delegate_task haben KEINE Befehls-Beschränkungen mehr: destruktive Befehle, Downloads, Datei-Umleitungen, Prozess-Steuerung usw. sind alle erlaubt — du arbeitest mit den vollen Rechten des angemeldeten Nutzers, wie in einem normalen Terminal. Echtes root gibt es nur mit sudo und Passwort (nicht-interaktiv nicht möglich). Nutze die Macht verantwortungsvoll: Führe zerstörerische oder weitreichende Befehle (löschen, überschreiben, Systemänderungen) nur auf klare Anweisung aus und fasse vorher kurz zusammen, was du tun wirst.`
        : "";
      const instructions = `${INSTRUCTIONS_PREAMBLE}\n\n${parts.join("\n\n")}${notesInfo}${skillsInfo}${galleryInfo}${cliInfo}${yoloInfo}`;

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
            .catch((e) => void api.logLine(`session start failed: ${String(e)}`));
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
          // Der Nutzer redet — was Otto zuletzt tat, ist Geschichte.
          if (flags.current.toolRunning === 0) clearActivity();
          recompute();
        },
        onSpeechStop: () => {
          flags.current.userSpeaking = false;
          flags.current.responseActive = true; // server_vad erzeugt gleich eine Antwort
          // Kommt binnen 10 s keine echte Antwort (Server-Fehler, Race),
          // darf die Insel nicht ewig "denkt" zeigen.
          if (speculativeTimer.current) clearTimeout(speculativeTimer.current);
          speculativeTimer.current = setTimeout(() => {
            if (flags.current.responseActive && !flags.current.playing) {
              flags.current.responseActive = false;
              recompute();
            }
          }, 10_000);
          recompute();
        },
        onResponseStart: () => {
          flags.current.responseActive = true;
          if (speculativeTimer.current) {
            clearTimeout(speculativeTimer.current);
            speculativeTimer.current = null;
          }
          // Diese Antwort sieht alle bereits eingestellten Items — Vormerker verfällt.
          pendingCreate.current = false;
          recompute();
        },
        onResponseDone: () => {
          flags.current.responseActive = false;
          if (speculativeTimer.current) {
            clearTimeout(speculativeTimer.current);
            speculativeTimer.current = null;
          }
          if (flags.current.toolRunning === 0) clearActivity();
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
          if (sid !== null) {
            void api
              .sessionAppend(sid, "user", text)
              .catch((e) => api.logLine(`session append user failed: ${String(e)}`));
          }
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
              void api
                .sessionAppend(sid, "assistant", text)
                .catch((e) => api.logLine(`session append assistant failed: ${String(e)}`));
            }
          }
        },
        onFunctionCall: (call) => void executeTool(call),
      });
      clientRef.current = client;
      // Deaktivierte Fähigkeiten werden Otto gar nicht erst angeboten.
      const tools = toolDefs.filter((t: { name?: string }) => {
        if (t.name === "run_terminal" && !current.terminal_enabled) return false;
        if (
          (t.name === "delegate_task" || t.name === "cancel_job") &&
          !current.cli_enabled
        )
          return false;
        // Job-Einsicht braucht mindestens eine Job-Quelle.
        if (
          (t.name === "read_job_output" || t.name === "show_job") &&
          !current.cli_enabled &&
          !current.terminal_enabled
        )
          return false;
        return true;
      });
      // MCP-Server aus den Einstellungen: eine Zeile pro Server,
      // "label https://…" oder nur die URL (Label wird dann abgeleitet).
      const mcpServers = (current.mcp_servers ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const parts = l.split(/\s+/);
          const url = parts.find((p) => /^https?:\/\//.test(p)) ?? "";
          const label =
            parts.filter((p) => p !== url).join("-") ||
            url.replace(/^https?:\/\//, "").split(/[/.]/)[0] ||
            "mcp";
          return { label: label.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), url };
        })
        .filter((s) => s.url);
      client.connect(current.openai_api_key.trim(), {
        model: current.model,
        voice: current.voice,
        instructions,
        tools,
        reasoningEffort: current.reasoning_effort,
        vadThreshold: current.vad_threshold,
        mcpServers,
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
  }, [clearActivity, executeTool, recompute, teardown]);

  useEffect(() => {
    return () => {
      clientRef.current?.close();
      engineRef.current?.stop();
    };
  }, []);

  const { dismiss } = useActivation({
    agentState,
    settings,
    flags,
    connect,
    disconnect,
    pushActivity,
    setError,
  });

  const toggleArtifactsWindow = usePanelSync({
    panelOpen,
    setPanelOpen,
    pendingPresent,
    artifacts,
    activeArtifactId,
    images,
    artifactStyle,
    artifactsRef,
    activeArtifactIdRef,
    imagesRef,
    artifactStyleRef,
    setActiveArtifactId,
    setSettings,
    closeArtifact,
    handleImageAction,
    reloadArtifactStyle,
  });

  return (
    <Island
      state={agentState}
      error={error}
      activity={activity}
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
