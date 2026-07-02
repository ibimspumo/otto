import { useEffect, useRef, useState } from "react";
import type { AgentState, TranscriptItem } from "../lib/types";
import Orb3D from "./Orb3D";

const STATE_LABEL: Record<AgentState, string> = {
  disconnected: "GETRENNT",
  connecting: "VERBINDE",
  idle: "BEREIT",
  listening: "HÖRT ZU",
  thinking: "DENKT NACH",
  speaking: "SPRICHT",
};

interface VoicePanelProps {
  state: AgentState;
  transcript: TranscriptItem[];
  error: string | null;
  sessionStart: number | null;
  activities: string[];
  levels: React.MutableRefObject<{ inp: number; out: number }>;
  onConnect: () => void;
  onDisconnect: () => void;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function VoicePanel({
  state,
  transcript,
  error,
  sessionStart,
  activities,
  levels,
  onConnect,
  onDisconnect,
}: VoicePanelProps) {
  const [elapsed, setElapsed] = useState("00:00");
  const scrollRef = useRef<HTMLDivElement>(null);
  const connected = state !== "disconnected" && state !== "connecting";

  useEffect(() => {
    if (!sessionStart) {
      setElapsed("00:00");
      return;
    }
    const tick = () => setElapsed(formatElapsed(Date.now() - sessionStart));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sessionStart]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  return (
    <section className="voice">
      <div className="voice-status mono">
        <span className={`dot ${state}`} />
        OTTO&nbsp;//&nbsp;{STATE_LABEL[state]}
        {connected && <span className="elapsed">&nbsp;·&nbsp;{elapsed}</span>}
      </div>

      <div className="orb-wrap hud-corners">
        <Orb3D state={state} levels={levels} />
      </div>

      <div className="activity mono" aria-live="polite">
        {activities.length === 0 ? (
          <div className="activity-line idle-line">
            {connected ? "— hört zu —" : "— offline —"}
          </div>
        ) : (
          activities.map((a, i) => (
            <div key={`${i}-${a}`} className="activity-line" data-age={i}>
              {i === 0 ? "▸ " : "· "}
              {a}
            </div>
          ))
        )}
      </div>

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 ? (
          <p className="transcript-empty">
            {connected
              ? "Otto hört. Sprich einfach los."
              : "Verbinde dich, dann sprich einfach los. Was Otto zeigt statt sagt, erscheint im Artefakt-Panel."}
          </p>
        ) : (
          transcript.map((item) => (
            <div key={item.id} className={`utterance ${item.role}`}>
              <span className="who">{item.role === "user" ? "DU" : "OTTO"}</span>
              <p>{item.text || "…"}</p>
            </div>
          ))
        )}
      </div>

      <div className="voice-controls">
        {connected ? (
          <button className="btn" onClick={onDisconnect}>
            Trennen
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={onConnect}
            disabled={state === "connecting"}
          >
            {state === "connecting" ? "Verbinde…" : "Verbinden"}
          </button>
        )}
      </div>

      {error && <div className="error-line">{error}</div>}
    </section>
  );
}
