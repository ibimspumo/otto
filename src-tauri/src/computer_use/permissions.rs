use serde_json::json;

// macOS-TCC-Freigaben: Bildschirmaufnahme (Screenshots) und
// Bedienungshilfen (synthetische Maus-/Tastatur-Events).
#[cfg(target_os = "macos")]
mod tcc {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
    }
}

/// Reine Preflight-Prüfung OHNE Nutzer-Dialog: löst KEINE TCC-Abfrage aus,
/// meldet nur den aktuellen Stand. `(bildschirmaufnahme, bedienungshilfen)`.
/// Wird für Diagnose/Logging und den Computer-Use-Standort-Check genutzt.
pub fn preflight() -> (bool, bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        (
            tcc::CGPreflightScreenCaptureAccess(),
            tcc::AXIsProcessTrusted(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        (true, true)
    }
}

/// Prüft (und fordert auf Wunsch an) die Systemfreigaben für Computer Use.
/// `request = true` löst den macOS-Dialog für Bildschirmaufnahme aus und
/// öffnet die Bedienungshilfen-Einstellungen, falls nötig.
#[tauri::command]
pub fn cu_permissions(request: bool) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut screen = tcc::CGPreflightScreenCaptureAccess();
        if !screen && request {
            screen = tcc::CGRequestScreenCaptureAccess();
        }
        let accessibility = tcc::AXIsProcessTrusted();
        if !accessibility && request {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                .status();
        }
        Ok(json!({ "screen": screen, "accessibility": accessibility }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok(json!({ "screen": true, "accessibility": true }))
    }
}

pub fn ensure_permissions() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (screen, accessibility) = preflight();
        if !screen || !accessibility {
            let mut missing = Vec::new();
            if !screen {
                missing.push("Bildschirmaufnahme");
            }
            if !accessibility {
                missing.push("Bedienungshilfen");
            }
            return Err(format!(
                "Fehlende macOS-Freigaben für Computer Use: {}. In den Einstellungen der App gibt es einen Button „Freigaben anfordern“; danach Otto neu starten. Sag das dem Nutzer.",
                missing.join(" und ")
            ));
        }
    }
    Ok(())
}
