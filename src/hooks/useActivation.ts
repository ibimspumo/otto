import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { hideIsland, showIsland, showSettings, toggleIsland } from "../lib/hudWindow";
import * as api from "../lib/tauriApi";
import type { AgentState, Settings } from "../lib/types";

interface UseActivationArgs {
  agentState: AgentState;
  settings: Settings | null;
  flags: MutableRefObject<{
    connected: boolean;
    connecting: boolean;
    userSpeaking: boolean;
    responseActive: boolean;
    playing: boolean;
    toolRunning: number;
  }>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  pushActivity: (text: string) => void;
  setError: (message: string | null) => void;
}

const isDoubleCmd = (combo: string) =>
  /^(2x ?cmd|cmd ?cmd|doppel[- ]?cmd|double[- ]?cmd|⌘⌘)$/i.test(combo);

export function useActivation({
  agentState,
  settings,
  flags,
  connect,
  disconnect,
  pushActivity,
  setError,
}: UseActivationArgs) {
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
  }, [flags]);

  const dismiss = useCallback(async () => {
    void disconnectRef.current();
    await hideIsland();
  }, []);

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
  }, [settings?.wake_word_enabled, settings?.wake_word_phrase, wakeActive, pushActivity]);

  useEffect(() => {
    const un = listen("wake-word", () => {
      void summonAndConnect();
    });
    return () => {
      un.then((f) => f());
    };
  }, [summonAndConnect]);

  // Bewusst NUR von den Hotkey-Feldern abhängig — hinge der Effekt am ganzen
  // settings-Objekt, würde jeder Auto-Save (debounced bei jedem Tastendruck
  // in den Einstellungen) den Hotkey ab- und neu registrieren: kurze
  // Totzeiten und Races zwischen überlappenden Effekt-Läufen.
  const hotkeyEnabled = settings?.hotkey_enabled ?? false;
  const hotkeyCombo = settings ? (settings.hotkey?.trim() ?? "") : null;
  useEffect(() => {
    if (hotkeyCombo === null) return; // Settings noch nicht geladen
    let disposed = false;
    (async () => {
      await unregisterAll().catch(() => {});
      await api.dblcmdStop().catch(() => {});
      if (!hotkeyEnabled || !hotkeyCombo || disposed) return;
      if (isDoubleCmd(hotkeyCombo)) {
        await api.dblcmdStart().catch((e) => {
          setError(
            `Doppel-Cmd ließ sich nicht aktivieren: ${String(e)} — braucht die Bedienungshilfen-Freigabe.`,
          );
        });
        if (disposed) await api.dblcmdStop().catch(() => {});
        return;
      }
      try {
        await register(hotkeyCombo, (event) => {
          if (event.state !== "Pressed") return;
          if (flags.current.connected || flags.current.connecting) {
            void dismiss();
          } else {
            void summonAndConnect();
          }
        });
        if (disposed) await unregisterAll().catch(() => {});
      } catch (e) {
        setError(`Hotkey „${hotkeyCombo}“ ließ sich nicht registrieren: ${String(e)}`);
      }
    })();
    return () => {
      disposed = true;
      void unregisterAll().catch(() => {});
      void api.dblcmdStop().catch(() => {});
    };
  }, [hotkeyCombo, hotkeyEnabled, flags, summonAndConnect, dismiss, setError]);

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
  }, [flags, dismiss, summonAndConnect]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  return { dismiss, summonAndConnect };
}
