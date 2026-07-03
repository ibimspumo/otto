// Bildschirm-Kontext: Was sieht der Nutzer gerade?
//
// Alles hier kommt OHNE neue TCC-Berechtigungen aus:
// - Fokussierte App: NSWorkspace (permission-frei).
// - Fenstertitel + markierter Text: Accessibility API — nutzt die
//   Bedienungshilfen-Freigabe, die Otto für den Doppel-Cmd-Hotkey
//   ohnehin braucht. Ohne Freigabe liefern die Felder schlicht null.
// - Mausposition + Displays: CoreGraphics (permission-frei).
// - Clipboard-Bild: NSPasteboard (bis mindestens macOS 16 permission-frei) —
//   der Zubringer für "Otto, schau auf meinen Bildschirm" via ⌘⇧⌃4.

use base64::Engine;
use objc2_app_kit::{NSPasteboard, NSWorkspace};
use serde::Serialize;

use crate::native::{cursor_location, display_bounds, on_main};

// ------------------------------------------------------------------
// Accessibility-FFI (ApplicationServices) — bewusst schmal gehalten.
// ------------------------------------------------------------------

type CFTypeRef = *const std::ffi::c_void;
type CFStringRef = *const std::ffi::c_void;
type AXUIElementRef = *const std::ffi::c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFStringCreateWithBytes(
        alloc: CFTypeRef,
        bytes: *const u8,
        num_bytes: isize,
        encoding: u32,
        external: bool,
    ) -> CFStringRef;
    fn CFStringGetLength(s: CFStringRef) -> isize;
    fn CFStringGetCString(s: CFStringRef, buf: *mut u8, size: isize, encoding: u32) -> bool;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

/// RAII-Hülle, damit kein CFRelease vergessen wird.
struct CfGuard(CFTypeRef);
impl Drop for CfGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

fn cf_string(s: &str) -> CfGuard {
    let r = unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            s.as_ptr(),
            s.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
            false,
        )
    };
    CfGuard(r)
}

fn cf_to_string(cf: CFTypeRef) -> Option<String> {
    if cf.is_null() {
        return None;
    }
    unsafe {
        if CFGetTypeID(cf) != CFStringGetTypeID() {
            return None;
        }
        let len = CFStringGetLength(cf);
        // UTF-8 braucht bis zu 4 Bytes pro UTF-16-Einheit + Nullterminator.
        let cap = len * 4 + 1;
        let mut buf = vec![0u8; cap as usize];
        if !CFStringGetCString(cf, buf.as_mut_ptr(), cap, K_CF_STRING_ENCODING_UTF8) {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        Some(String::from_utf8_lossy(&buf[..end]).into_owned())
    }
}

/// Liest ein Attribut eines AX-Elements als String (oder als Element).
fn ax_copy(element: AXUIElementRef, attribute: &str) -> Option<CfGuard> {
    let attr = cf_string(attribute);
    let mut value: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(element, attr.0, &mut value) };
    if err != 0 || value.is_null() {
        return None;
    }
    Some(CfGuard(value))
}

fn ax_string(element: AXUIElementRef, attribute: &str) -> Option<String> {
    let v = ax_copy(element, attribute)?;
    let s = cf_to_string(v.0)?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Titel des fokussierten Fensters der App mit dieser pid (via AX).
fn focused_window_title(pid: i32) -> Option<String> {
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return None;
    }
    let app_guard = CfGuard(app);
    let win = ax_copy(app_guard.0, "AXFocusedWindow")?;
    ax_string(win.0, "AXTitle")
}

/// Aktuell markierter Text im fokussierten Element (systemweit, via AX).
/// Funktioniert gut in nativen Apps, in Browsern/Electron oft nicht —
/// dann ist das Feld eben null.
fn selected_text() -> Option<String> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return None;
    }
    let system_guard = CfGuard(system);
    let focused = ax_copy(system_guard.0, "AXFocusedUIElement")?;
    let text = ax_string(focused.0, "AXSelectedText")?;
    // Absurd lange Selektionen kappen — das ist Kontext, kein Datentransfer.
    Some(text.chars().take(4000).collect())
}

// ------------------------------------------------------------------
// Der Kontext-Befehl
// ------------------------------------------------------------------

#[derive(Serialize)]
pub struct ScreenContext {
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub selected_text: Option<String>,
    pub mouse: Option<(f64, f64)>,
    /// 1-basierter Index des Displays, auf dem der Cursor steht.
    pub mouse_display: Option<u32>,
    pub display_count: u32,
    pub accessibility: bool,
}

#[tauri::command]
pub fn screen_context(app: tauri::AppHandle) -> Result<ScreenContext, String> {
    // NSWorkspace gehört auf den Main-Thread; AX-Aufrufe sind dort ebenfalls
    // am verlässlichsten.
    on_main(&app, || {
        let ws = NSWorkspace::sharedWorkspace();
        let front = ws.frontmostApplication();
        let (app_name, bundle_id, pid) = match front {
            Some(a) => (
                a.localizedName().map(|s| s.to_string()),
                a.bundleIdentifier().map(|s| s.to_string()),
                Some(a.processIdentifier()),
            ),
            None => (None, None, None),
        };
        let accessibility = crate::diagnostics::accessibility_granted();
        let window_title = if accessibility {
            pid.and_then(focused_window_title)
        } else {
            None
        };
        let sel = if accessibility { selected_text() } else { None };

        let mouse = cursor_location().map(|p| (p.x, p.y));
        let bounds = display_bounds();
        let mouse_display = mouse.and_then(|(x, y)| {
            bounds.iter().position(|b| {
                x >= b.origin.x
                    && x < b.origin.x + b.size.width
                    && y >= b.origin.y
                    && y < b.origin.y + b.size.height
            })
        });
        Ok(ScreenContext {
            app_name,
            bundle_id,
            window_title,
            selected_text: sel,
            mouse,
            mouse_display: mouse_display.map(|i| i as u32 + 1),
            display_count: bounds.len() as u32,
            accessibility,
        })
    })?
}

// ------------------------------------------------------------------
// Clipboard-Bild: der permission-freie "Sehen"-Kanal
// ------------------------------------------------------------------

/// Liest eine lokale Datei als Base64 — für Dokument-Input (PDF).
/// Bewusst begrenzt: nur existierende Dateien bis 25 MB.
#[tauri::command]
pub fn file_read_b64(path: String) -> Result<String, String> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{}", std::env::var("HOME").unwrap_or_default(), rest)
    } else {
        path
    };
    let meta = std::fs::metadata(&expanded)
        .map_err(|_| format!("Datei nicht gefunden: {expanded}"))?;
    if !meta.is_file() {
        return Err(format!("Kein normaler Dateipfad: {expanded}"));
    }
    if meta.len() > 25 * 1024 * 1024 {
        return Err("Datei größer als 25 MB — zu groß für Dokument-Input.".into());
    }
    let bytes = std::fs::read(&expanded).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[derive(Serialize)]
pub struct ClipboardImage {
    /// PNG oder TIFF als Base64 — das Frontend skaliert und konvertiert.
    pub b64: String,
    pub format: String,
}

#[tauri::command]
pub fn clipboard_image(app: tauri::AppHandle) -> Result<Option<ClipboardImage>, String> {
    on_main(&app, || {
        let pb = NSPasteboard::generalPasteboard();
        for (uti, format) in [("public.png", "png"), ("public.tiff", "tiff")] {
            let t = objc2_foundation::NSString::from_str(uti);
            if let Some(data) = pb.dataForType(&t) {
                let bytes = data.to_vec();
                if bytes.is_empty() {
                    continue;
                }
                return Ok(Some(ClipboardImage {
                    b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    format: format.to_string(),
                }));
            }
        }
        Ok(None)
    })?
}
