// Native macOS-Helfer, die AppKit brauchen:
//
// 1. `top_inset` — Höhe von Notch/Menüleiste (Safe Area) in logischen
//    Punkten, damit die Insel exakt darunter schweben kann.
// 2. Doppel-Cmd-Erkennung — ein globaler NSEvent-Monitor auf FlagsChanged:
//    zweimal ⌘ kurz hintereinander (ohne andere Modifier) feuert das Event
//    "double-cmd" ans Frontend. Modifier-only-Taps kann das Global-Shortcut-
//    Plugin nicht; dafür braucht es diesen Monitor (und die Bedienungs-
//    hilfen-Freigabe, sonst liefert macOS schlicht keine Events).

use std::cell::{Cell, RefCell};
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
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

fn on_main<T: Send + 'static>(
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
    MONITOR.with(|m| {
        if m.borrow().is_some() {
            return;
        }
        // Zustand lebt im Block: war ⌘ zuletzt gedrückt, wann war der letzte Tap?
        let prev_cmd = Cell::new(false);
        let last_tap = Cell::new(0u128);
        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let flags = unsafe { event.as_ref().modifierFlags() };
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
        });
        let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::FlagsChanged,
            &block,
        );
        *m.borrow_mut() = monitor;
    });
}

fn dbl_stop_on_main() {
    MONITOR.with(|m| {
        if let Some(monitor) = m.borrow_mut().take() {
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
