import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cuCancel } from "./lib/tauriApi";
import Orb3D from "./components/Orb3D";
import type { AgentState } from "./lib/types";

/**
 * Inhalt des kleinen transparenten Always-on-top-Fensters, das während
 * Computer Use in der Bildschirmecke sitzt. Per Drag verschiebbar,
 * mit Abbrechen-Button; Zustand und Aktivitätstext kommen per Tauri-Events.
 */
export default function MiniOrb() {
  const [state, setState] = useState<AgentState>("thinking");
  const [label, setLabel] = useState("arbeitet…");
  const levels = useRef({ inp: 0, out: 0 });

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const unState = listen<{ state: AgentState }>("otto-activity", (e) =>
      setState(e.payload.state),
    );
    const unStatus = listen<{ text: string }>("cu-status", (e) =>
      setLabel(e.payload.text),
    );
    return () => {
      unState.then((f) => f());
      unStatus.then((f) => f());
    };
  }, []);

  return (
    <div className="mini-root" data-tauri-drag-region>
      <div data-tauri-drag-region>
        <Orb3D state={state} levels={levels} size={160} />
      </div>
      <div className="mini-label mono">{label}</div>
      <button
        className="mini-stop mono"
        title="Computer Use abbrechen"
        onClick={() => void cuCancel().catch(() => {})}
      >
        ✕ Abbrechen
      </button>
    </div>
  );
}
