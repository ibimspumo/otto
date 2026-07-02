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
    toolRunning: boolean;
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
  }, [settings, settings?.hotkey, settings?.hotkey_enabled, flags, summonAndConnect, dismiss, setError]);

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
