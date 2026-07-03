import { useEffect, useMemo, useState } from "react";
import { layoutIsland } from "../lib/hudWindow";
import type { Update } from "../lib/updater";
import type { AgentState, CliJob } from "../lib/types";
import Orb3D from "./Orb3D";

interface IslandProps {
  state: AgentState;
  error: string | null;
  /** Was Otto GERADE tut — von App.tsx aktiv gepflegt und gelöscht. */
  activity: string | null;
  jobs: CliJob[];
  onCancelJob: (id: string) => void;
  levels: React.MutableRefObject<{ inp: number; out: number }>;
  onConnect: () => void;
  onDisconnect: () => void;
  artifactCount: number;
  panelOpen: boolean;
  onToggleArtifacts: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
  update: Update | null;
  updateProgress: number | null;
  onUpdate: () => void;
}

const STATE_LABEL: Record<AgentState, string> = {
  disconnected: "getrennt",
  connecting: "verbindet",
  idle: "bereit",
  listening: "hört zu",
  thinking: "denkt",
  speaking: "spricht",
};

/**
 * Die Insel: eine schwarze Kapsel, die oben mittig aus dem Notch wächst.
 * Im Ruhezustand lebt darin nur der Kern; sobald Otto arbeitet (Caption)
 * oder die Maus darüber schwebt, weitet sich die Kapsel — das Fenster
 * wächst mit (layoutIsland), damit nie unsichtbare Fläche Klicks frisst.
 * Das Zustandslicht strahlt als Glow unter der Kapsel auf den Bildschirm.
 */
export default function Island({
  state,
  error,
  activity,
  jobs,
  onCancelJob,
  levels,
  onConnect,
  onDisconnect,
  artifactCount,
  panelOpen,
  onToggleArtifacts,
  onDismiss,
  onOpenSettings,
  update,
  updateProgress,
  onUpdate,
}: IslandProps) {
  const [hovered, setHovered] = useState(false);
  const connected = state !== "disconnected" && state !== "connecting";

  // Eine Zeile Wahrheit: Fehler > Verbinden > aktuelle Tätigkeit > Denken > Jobs.
  // `activity` ist nie veraltet — App.tsx löscht sie beim Ende jeder Aktion.
  const caption = useMemo(() => {
    if (error) return error;
    if (state === "connecting") return "verbinde…";
    if (activity) return activity;
    if (state === "thinking") return "denkt nach…";
    if (jobs.length > 0 && !hovered) {
      return jobs.length === 1
        ? `${jobs[0].agent} arbeitet im Hintergrund…`
        : `${jobs.length} Jobs laufen im Hintergrund…`;
    }
    return null;
  }, [error, state, activity, jobs, hovered]);

  const wide = hovered || caption !== null;

  // Fenstergröße folgt dem Inhalt — nie unsichtbare Klickfläche.
  useEffect(() => {
    void layoutIsland(wide ? "wide" : "compact");
  }, [wide]);

  return (
    <div className="island-stage" data-state={state}>
      <div
        className={`island ${wide ? "wide" : ""}`}
        role="status"
        aria-label={`Otto ${STATE_LABEL[state]}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="island-inner">
          <div className="island-core" aria-hidden>
            <Orb3D state={state} levels={levels} variant="core" size={72} />
          </div>

          <div className="island-middle">
            {hovered && jobs.length > 0 ? (
              <div className="island-jobs">
                {jobs.slice(0, 2).map((j) => (
                  <span key={j.id} className="island-job" title={j.task}>
                    <span className="island-job-name">{j.agent}</span>
                    <button
                      className="island-job-cancel"
                      title="Job abbrechen"
                      aria-label={`Job ${j.id} abbrechen`}
                      onClick={() => onCancelJob(j.id)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                {jobs.length > 2 && (
                  <span className="island-job">+{jobs.length - 2}</span>
                )}
              </div>
            ) : caption ? (
              <span
                key={caption}
                className={`island-caption ${error ? "error" : ""}`}
                aria-live="polite"
              >
                {caption}
              </span>
            ) : hovered ? (
              <span className="island-caption dim">{STATE_LABEL[state]}</span>
            ) : null}
          </div>

          {hovered && (
            <div className="island-controls">
              {update && (
                <button
                  className="island-btn update"
                  title={`Update auf ${update.version} installieren`}
                  aria-label={`Update auf ${update.version} installieren`}
                  disabled={updateProgress !== null}
                  onClick={onUpdate}
                >
                  {updateProgress === null ? "↑" : `${updateProgress}%`}
                </button>
              )}
              <button
                className={`island-btn ${connected ? "active" : ""}`}
                title={connected ? "Trennen" : "Verbinden"}
                aria-label={connected ? "Trennen" : "Verbinden"}
                disabled={state === "connecting"}
                onClick={connected ? onDisconnect : onConnect}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              </button>
              <button
                className={`island-btn ${panelOpen ? "active" : ""}`}
                title="Ergebnisse zeigen/verbergen"
                aria-label="Ergebnisse zeigen/verbergen"
                onClick={onToggleArtifacts}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <path d="M3 9h18" opacity="0.6" />
                </svg>
                {artifactCount > 0 && (
                  <span className="island-badge">{artifactCount}</span>
                )}
              </button>
              <button
                className="island-btn"
                title="Einstellungen"
                aria-label="Einstellungen"
                onClick={onOpenSettings}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
                </svg>
              </button>
              <button
                className="island-btn"
                title="Ausblenden (Esc) — Otto bleibt in der Menüleiste"
                aria-label="Ausblenden"
                onClick={onDismiss}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Das Zustandslicht: strahlt unter der Kapsel auf den Bildschirm. */}
      <div className="island-glow" aria-hidden />
    </div>
  );
}
