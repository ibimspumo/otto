import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  appDiagnostics,
  cliAvailable,
  logLine,
  requestAccessibility,
  saveSettings,
} from "../lib/tauriApi";
import { fetchImageModels, IMAGE_MODELS, type ImageModelInfo } from "../lib/imagegen";
import { checkForUpdate, installAndRelaunch, type Update } from "../lib/updater";
import type { SettingsSection } from "../lib/hudWindow";
import type { Diagnostics, Settings } from "../lib/types";
import {
  ActivationSettings,
  CapabilitySettings,
  DiagnosticsSettings,
  GeneralSettings,
  ImageSettings,
  KeySettings,
  MemorySettings,
  VoiceSettings,
} from "./settings/SettingsSections";

interface SettingsPanelProps {
  section: Exclude<SettingsSection, "persona">;
  settings: Settings | null;
  onSaved: (settings: Settings) => void;
}

/**
 * Ein Abschnitt der Einstellungen. Speichert automatisch (debounced) —
 * wie die Systemeinstellungen: keine Speichern-Knöpfe, nur ein stilles
 * „Gespeichert" unten rechts.
 */
export default function SettingsPanel({
  section,
  settings,
  onSaved,
}: SettingsPanelProps) {
  const [form, setForm] = useState<Settings | null>(settings);
  const [saved, setSaved] = useState(false);
  const [permStatus, setPermStatus] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [foundUpdate, setFoundUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [cliStatus, setCliStatus] = useState<{
    codex: boolean;
    claude: boolean;
  } | null>(null);
  const [imageModels, setImageModels] = useState<ImageModelInfo[]>(
    IMAGE_MODELS.map((m) => ({ id: m.id, label: m.label, provider: m.provider })),
  );
  const [modelFilter, setModelFilter] = useState("");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cliAvailable().then(setCliStatus).catch(() => setCliStatus(null));
    invoke<boolean>("plugin:autostart|is_enabled")
      .then(setAutostart)
      .catch(() => setAutostart(null));
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const refreshDiag = () => {
    appDiagnostics()
      .then(setDiag)
      .catch((e) => void logLine(`diagnostics failed: ${String(e)}`));
  };

  useEffect(() => {
    if (section === "diagnose" && !diag) refreshDiag();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  useEffect(() => {
    const key = settings?.openrouter_api_key ?? "";
    fetchImageModels(key)
      .then(setImageModels)
      .catch((e) => void logLine(`image model list failed: ${String(e)}`));
  }, [settings?.openrouter_api_key]);

  if (!form) return <div className="settings-pane" />;

  const set = (patch: Partial<Settings>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await saveSettings(next);
        onSaved(next);
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1800);
      } catch (e) {
        void logLine(`settings save failed: ${String(e)}`);
      }
    }, 500);
  };

  async function toggleAutostart(enable: boolean) {
    try {
      await invoke(enable ? "plugin:autostart|enable" : "plugin:autostart|disable");
      setAutostart(enable);
    } catch {
      // Im Dev-Modus nicht verfügbar — Anzeige unverändert lassen.
    }
  }

  async function runUpdateCheck() {
    setUpdateStatus("Prüfe…");
    setFoundUpdate(null);
    const u = await checkForUpdate();
    if (u) {
      setFoundUpdate(u);
      setUpdateStatus(`Update auf Version ${u.version} verfügbar.`);
    } else {
      setUpdateStatus(
        "Otto ist aktuell (oder die Prüfung ist im Dev-Modus nicht möglich).",
      );
    }
  }

  async function installUpdate() {
    if (!foundUpdate || installing) return;
    setInstalling(true);
    try {
      await installAndRelaunch(foundUpdate, (p) =>
        setUpdateStatus(`Lädt herunter… ${p}%`),
      );
    } catch (e) {
      setInstalling(false);
      setUpdateStatus(`Update fehlgeschlagen: ${String(e)}`);
    }
  }

  async function checkPermissions() {
    try {
      const granted = await requestAccessibility();
      setPermStatus(
        granted
          ? "Bedienungshilfen: ✓"
          : "Bedienungshilfen: ✗ — nach dem Erteilen Otto neu starten.",
      );
    } catch (e) {
      setPermStatus(String(e));
    }
  }

  const shared = { form, set };
  const body = (() => {
    switch (section) {
      case "allgemein":
        return (
          <GeneralSettings
            autostart={autostart}
            updateStatus={updateStatus}
            foundUpdate={foundUpdate}
            installing={installing}
            onToggleAutostart={(v) => void toggleAutostart(v)}
            onRunUpdateCheck={() => void runUpdateCheck()}
            onInstallUpdate={() => void installUpdate()}
          />
        );
      case "aktivierung":
        return (
          <ActivationSettings
            {...shared}
            permStatus={permStatus}
            onCheckPermissions={() => void checkPermissions()}
          />
        );
      case "stimme":
        return <VoiceSettings {...shared} />;
      case "keys":
        return <KeySettings {...shared} />;
      case "bilder":
        return (
          <ImageSettings
            {...shared}
            imageModels={imageModels}
            modelFilter={modelFilter}
            setModelFilter={setModelFilter}
          />
        );
      case "gedaechtnis":
        return <MemorySettings {...shared} />;
      case "faehigkeiten":
        return <CapabilitySettings {...shared} cliStatus={cliStatus} />;
      case "diagnose":
        return <DiagnosticsSettings diag={diag} onRefresh={refreshDiag} />;
    }
  })();

  return (
    <div className="settings-pane">
      {body}
      <div className={`autosave ${saved ? "visible" : ""}`} aria-live="polite">
        Gespeichert
      </div>
    </div>
  );
}
