// Native macOS-Helfer, die AppKit brauchen:
//
// 1. `top_inset` — Höhe von Notch/Menüleiste (Safe Area) in logischen
//    Punkten, damit die Insel exakt darunter schweben kann.
// 2. Doppel-Cmd-Erkennung — NSEvent-Monitore auf FlagsChanged: zweimal ⌘
//    kurz hintereinander (ohne andere Modifier) feuert das Event
//    "double-cmd" ans Frontend. Modifier-only-Taps kann das Global-Shortcut-
//    Plugin nicht; dafür braucht es diese Monitore (und die Bedienungs-
//    hilfen-Freigabe, sonst liefert macOS schlicht keine Events).
//    Es sind ZWEI Monitore: Der globale sieht nur Events, die an ANDERE
//    Apps gehen — ist ein Otto-Fenster selbst Key, kommt dort nichts an.
//    Der lokale deckt den eigenen Prozess ab; beide teilen sich den
//    Tap-Zustand.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSScreen};
use tauri::Emitter;

/// Zwei ⌘-Taps innerhalb dieses Fensters gelten als Doppel-Cmd.
const DOUBLE_MS: u128 = 400;

thread_local! {
    static MONITORS: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Timeout auf dem Main-Thread.".to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Höhe des oberen Bildschirm-Einschnitts in logischen Punkten:
/// Safe-Area (Notch) bzw. Menüleiste, je nachdem, was größer ist.
#[tauri::command]
pub fn top_inset(app: tauri::AppHandle) -> Result<f64, String> {
    on_main(&app, || {
        let Some(mtm) = MainThreadMarker::new() else {
            return 38.0;
        };
        let Some(screen) = NSScreen::mainScreen(mtm) else {
            return 38.0;
        };
        let safe = screen.safeAreaInsets().top;
        let frame = screen.frame();
        let visible = screen.visibleFrame();
        let menubar =
            (frame.origin.y + frame.size.height) - (visible.origin.y + visible.size.height);
        safe.max(menubar).max(24.0)
    })
}

fn dbl_start_on_main(app: tauri::AppHandle) {
    MONITORS.with(|m| {
        if !m.borrow().is_empty() {
            return;
        }
        // Geteilter Zustand: war ⌘ zuletzt gedrückt, wann war der letzte Tap?
        // Rc, weil globaler und lokaler Monitor dieselbe Sequenz sehen müssen
        // (der erste Tap kann außerhalb, der zweite innerhalb der App landen).
        let state = Rc::new((Cell::new(false), Cell::new(0u128)));
        let on_flags = move |flags: NSEventModifierFlags| {
            let (prev_cmd, last_tap) = &*state;
            let independent =
                flags.intersection(NSEventModifierFlags::DeviceIndependentFlagsMask);
            let cmd_only = independent == NSEventModifierFlags::Command;
            if cmd_only && !prev_cmd.get() {
                let now = now_ms();
                if now.saturating_sub(last_tap.get()) < DOUBLE_MS {
                    last_tap.set(0);
                    let _ = app.emit("double-cmd", ());
                } else {
                    last_tap.set(now);
                }
            } else if !independent.is_empty() && !cmd_only {
                // Andere Kombination (⌘C, Shift, …) bricht die Sequenz ab.
                last_tap.set(0);
            }
            prev_cmd.set(cmd_only);
        };
        let mut monitors = m.borrow_mut();
        let global_flags = on_flags.clone();
        let global_block = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            global_flags(unsafe { event.as_ref().modifierFlags() });
        });
        if let Some(monitor) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::FlagsChanged,
            &global_block,
        ) {
            monitors.push(monitor);
        }
        // Lokale Monitore reichen das Event weiter (Rückgabe != null),
        // sonst käme es nie bei den Fenstern an.
        let local_block =
            block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                on_flags(unsafe { event.as_ref().modifierFlags() });
                event.as_ptr()
            });
        if let Some(monitor) = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::FlagsChanged,
                &local_block,
            )
        } {
            monitors.push(monitor);
        }
    });
}

fn dbl_stop_on_main() {
    MONITORS.with(|m| {
        for monitor in m.borrow_mut().drain(..) {
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
}

#[tauri::command]
pub fn dblcmd_start(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || dbl_start_on_main(app2))
}

#[tauri::command]
pub fn dblcmd_stop(app: tauri::AppHandle) -> Result<(), String> {
    on_main(&app, dbl_stop_on_main)
}

// ------------------------------------------------------------------
// Hot Corner: Maus in der Ecke unten links weckt den Drop-Stapel.
//
// Komplett permission-frei: CGEventCreate/CGEventGetLocation lesen die
// Cursor-Position ohne TCC (geschützt ist nur das ABHÖREN von Events),
// CGDisplayBounds liefert die Display-Rechtecke im selben globalen
// Punkt-Koordinatensystem (Ursprung oben links am Hauptdisplay) —
// multi-monitor-sicher ohne Umrechnungs-Akrobatik im Frontend.
// ------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct CGSize {
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct CGRect {
    pub origin: CGPoint,
    pub size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    fn CGGetActiveDisplayList(max: u32, ids: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: u32) -> CGRect;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

/// Globale Cursor-Position in Punkten (Ursprung oben links, Hauptdisplay).
pub(crate) fn cursor_location() -> Option<CGPoint> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let loc = CGEventGetLocation(event);
        CFRelease(event);
        Some(loc)
    }
}

/// Alle aktiven Display-Rechtecke im globalen Punkt-Koordinatensystem.
pub(crate) fn display_bounds() -> Vec<CGRect> {
    let mut ids = [0u32; 8];
    let mut count = 0u32;
    let ok = unsafe { CGGetActiveDisplayList(8, ids.as_mut_ptr(), &mut count) };
    if ok != 0 {
        return Vec::new();
    }
    ids.iter()
        .take(count as usize)
        .map(|&id| unsafe { CGDisplayBounds(id) })
        .collect()
}

/// Liegt der Cursor in der Ecke unten links IRGENDEINES Displays?
fn in_bottom_left_corner(zone: f64) -> bool {
    let Some(loc) = cursor_location() else {
        return false;
    };
    for b in display_bounds() {
        let left = b.origin.x;
        let bottom = b.origin.y + b.size.height;
        if loc.x <= left + zone && loc.y >= bottom - zone {
            return true;
        }
    }
    false
}

fn hot_corner_running() -> &'static std::sync::atomic::AtomicBool {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &RUNNING
}

/// Startet den Ecken-Poller (idempotent). Feuert "hot-corner" beim
/// EINTRITT in die Zone (flankengesteuert, kein Dauerfeuer).
#[tauri::command]
pub fn hot_corner_start(app: tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    if hot_corner_running().swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut inside = false;
        while hot_corner_running().load(Ordering::SeqCst) {
            let now_inside = in_bottom_left_corner(14.0);
            if now_inside && !inside {
                let _ = app.emit("hot-corner", ());
            }
            inside = now_inside;
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

#[tauri::command]
pub fn hot_corner_stop() {
    hot_corner_running().store(false, std::sync::atomic::Ordering::SeqCst);
}
