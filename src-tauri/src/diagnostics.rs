//! App-Identität & Laufumgebung — Diagnose für robuste TCC-Behandlung OHNE
//! Apple-Code-Signing.
//!
//! macOS bindet erteilte Freigaben (z. B. Bedienungshilfen für den
//! Doppel-Cmd-Hotkey) an die Code-Identität bzw. den Pfad der App. Ohne
//! Signatur bricht das auf zwei Arten:
//!  - **App Translocation (Gatekeeper Path Randomization):** wird eine frisch
//!    geladene, quarantänebehaftete App direkt aus dem Download/DMG gestartet,
//!    läuft sie aus einem zufälligen, schreibgeschützten Pfad unter
//!    `…/AppTranslocation/…`. TCC-Freigaben gelten dann nie dauerhaft.
//!  - **Dev-/Debug-Binary:** die lose Binary aus `target/debug` hat eine andere
//!    Identität als die installierte `.app` — Freigaben der einen gelten nicht
//!    für die andere.
//!
//! Die einzige robuste Abhilfe ohne Signing: die App per Finder nach
//! `/Applications` verschieben, die Quarantäne entfernen und neu starten. Dieses
//! Modul erkennt die Fehlzustände, loggt sie beim Start und liefert dem Frontend
//! die Fakten für einen klaren Handlungshinweis.

use serde::Serialize;
use std::path::{Path, PathBuf};

// macOS-TCC: Bedienungshilfen (braucht der native Doppel-Cmd-Hotkey).
#[cfg(target_os = "macos")]
mod tcc {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
    }
}

/// Reine Vorprüfung der Bedienungshilfen-Freigabe OHNE Nutzer-Dialog.
pub fn accessibility_granted() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        tcc::AXIsProcessTrusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Öffnet bei fehlender Bedienungshilfen-Freigabe die Systemeinstellungen und
/// meldet den aktuellen Stand. Wird vom „Anfordern“-Knopf der Einstellungen
/// genutzt — der Doppel-Cmd-Hotkey braucht diese Freigabe.
#[tauri::command]
pub fn request_accessibility() -> Result<bool, String> {
    let granted = accessibility_granted();
    #[cfg(target_os = "macos")]
    if !granted {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status();
    }
    Ok(granted)
}

/// Momentaufnahme der App-Identität und der TCC-Vorprüfung.
#[derive(Serialize, Clone, Debug)]
pub struct Diagnostics {
    /// Pfad der laufenden Executable.
    pub exe_path: String,
    /// Pfad des umschließenden `.app`-Bundles, falls vorhanden.
    pub bundle_path: Option<String>,
    /// Bundle-ID aus der Tauri-Konfiguration (z. B. `de.agentz.otto`).
    pub bundle_id: String,
    /// Läuft die App aus einer translozierten Kopie (Path Randomization)?
    pub translocated: bool,
    /// Liegt die App in `/Applications` bzw. `~/Applications`?
    pub in_applications: bool,
    /// Lose Dev-/Debug-Binary (kein `.app`-Bundle bzw. Debug-Build)?
    pub dev_build: bool,
    /// Quarantäne-Attribut gesetzt? `None` = nicht ermittelbar.
    pub quarantined: Option<bool>,
    /// Vorprüfung Bedienungshilfen (löst KEINEN Dialog aus).
    pub accessibility: bool,
}

/// Pfad der laufenden Executable (leerer Pfad, falls nicht ermittelbar).
pub fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_default()
}

/// Sucht das umschließende `.app`-Bundle, indem der Pfad nach oben gelaufen
/// wird. Eine gebündelte App liegt unter `…/Otto.app/Contents/MacOS/otto`.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        .map(Path::to_path_buf)
}

/// App Translocation erkennen: macOS startet quarantänebehaftete, unsignierte
/// Apps aus einem zufälligen Pfad, der das Segment `AppTranslocation` enthält.
pub fn is_translocated(p: &Path) -> bool {
    p.components()
        .any(|c| c.as_os_str().to_string_lossy() == "AppTranslocation")
}

/// Liegt die App im Programme-Ordner (System- oder Nutzer-`Applications`)?
pub fn in_applications(p: &Path) -> bool {
    let s = p.to_string_lossy();
    if s.starts_with("/Applications/") {
        return true;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let user_apps = Path::new(&home).join("Applications");
        return p.starts_with(&user_apps);
    }
    false
}

/// Lose Dev-/Debug-Binary: kein `.app`-Bundle drumherum oder ein Debug-Build.
/// Die installierte Produktions-App ist ein Release-Build in einem Bundle.
pub fn is_dev_build(exe: &Path) -> bool {
    cfg!(debug_assertions) || app_bundle(exe).is_none()
}

/// Quarantäne-Status via `xattr` — ohne Zusatzrechte lesbar.
/// `Some(true)` = Attribut gesetzt, `Some(false)` = keins, `None` = unbekannt.
pub fn quarantine(p: &Path) -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("xattr")
            .arg("-p")
            .arg("com.apple.quarantine")
            .arg(p)
            .output()
            .ok()?;
        if out.status.success() {
            // Erfolg mit nicht-leerem Wert ⇒ Attribut vorhanden.
            return Some(!out.stdout.is_empty());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("No such xattr") {
            return Some(false);
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = p;
        Some(false)
    }
}

/// Alle Fakten einsammeln.
pub fn collect(app: &tauri::AppHandle) -> Diagnostics {
    let exe = exe_path();
    let bundle = app_bundle(&exe);
    // Quarantäne prüft man am Bundle, sonst an der Executable.
    let quarantine_target = bundle.as_deref().unwrap_or(&exe);
    Diagnostics {
        exe_path: exe.to_string_lossy().to_string(),
        bundle_path: bundle.as_ref().map(|p| p.to_string_lossy().to_string()),
        bundle_id: app.config().identifier.clone(),
        translocated: is_translocated(&exe),
        in_applications: in_applications(&exe),
        dev_build: is_dev_build(&exe),
        quarantined: quarantine(quarantine_target),
        accessibility: accessibility_granted(),
    }
}

/// Frontend-Command: liefert die Diagnose für den UI-Hinweis und die
/// Einstellungen.
#[tauri::command]
pub fn app_diagnostics(app: tauri::AppHandle) -> Diagnostics {
    collect(&app)
}

/// Beim Start eine kompakte Zeile mit App-Identität & Preflight-Ergebnis nach
/// `otto.log` schreiben (und bei kritischen Zuständen zusätzlich ins
/// Crash-Log), damit TCC-Probleme im Nachhinein nachvollziehbar sind.
pub fn log_startup(app: &tauri::AppHandle) {
    let d = collect(app);
    let quar = match d.quarantined {
        Some(true) => "ja",
        Some(false) => "nein",
        None => "?",
    };
    let line = format!(
        "diagnostics: exe={} bundle={} id={} translocated={} in_applications={} dev_build={} quarantined={} accessibility={}",
        d.exe_path,
        d.bundle_path.as_deref().unwrap_or("-"),
        d.bundle_id,
        d.translocated,
        d.in_applications,
        d.dev_build,
        quar,
        d.accessibility,
    );
    let _ = crate::logging::log_line(app.clone(), line.clone());
    if d.translocated || (!d.in_applications && !d.dev_build) {
        crate::logging::crash_log(&line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erkennt_translozierten_pfad() {
        let p = Path::new(
            "/private/var/folders/xy/abc/AppTranslocation/1234-ABCD/d/Otto.app/Contents/MacOS/otto",
        );
        assert!(is_translocated(p));
    }

    #[test]
    fn normaler_pfad_ist_nicht_transloziert() {
        let p = Path::new("/Applications/Otto.app/Contents/MacOS/otto");
        assert!(!is_translocated(p));
    }

    #[test]
    fn findet_umschliessendes_bundle() {
        let p = Path::new("/Applications/Otto.app/Contents/MacOS/otto");
        assert_eq!(
            app_bundle(p),
            Some(PathBuf::from("/Applications/Otto.app")),
        );
    }

    #[test]
    fn lose_binary_hat_kein_bundle() {
        let p = Path::new("/Users/x/Otto/src-tauri/target/debug/otto");
        assert_eq!(app_bundle(p), None);
    }

    #[test]
    fn applications_pfad_wird_erkannt() {
        assert!(in_applications(Path::new(
            "/Applications/Otto.app/Contents/MacOS/otto"
        )));
        assert!(!in_applications(Path::new(
            "/Users/x/Downloads/Otto.app/Contents/MacOS/otto"
        )));
    }

    #[test]
    fn lose_binary_gilt_als_dev_build() {
        // Ohne umschließendes .app-Bundle ⇒ Dev-Build, unabhängig vom Profil.
        let p = Path::new("/Users/x/Otto/src-tauri/target/release/otto");
        assert!(is_dev_build(p));
    }
}
