// Wake-Word-Erkennung („Hey Otto“) über NSSpeechRecognizer — komplett offline,
// keine API-Kosten. Der Recognizer lauscht auf eine feste Kommando-Liste und
// meldet Treffer als "wake-word"-Event ans Frontend, das dann die
// Realtime-Session aufbaut.
//
// NSSpeechRecognizer ist main-thread-gebunden; die Tauri-Commands springen
// deshalb per run_on_main_thread dorthin und liefern das Ergebnis über einen
// Channel zurück.

use std::cell::RefCell;
use std::sync::mpsc;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSSpeechRecognizer, NSSpeechRecognizerDelegate};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};
use tauri::Emitter;

pub struct Ivars {
    app: tauri::AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "OttoWakeDelegate"]
    #[ivars = Ivars]
    struct WakeDelegate;

    unsafe impl NSObjectProtocol for WakeDelegate {}

    unsafe impl NSSpeechRecognizerDelegate for WakeDelegate {
        #[unsafe(method(speechRecognizer:didRecognizeCommand:))]
        fn did_recognize(&self, _sender: &NSSpeechRecognizer, command: &NSString) {
            let _ = self.ivars().app.emit("wake-word", command.to_string());
        }
    }
);

impl WakeDelegate {
    fn new(mtm: MainThreadMarker, app: tauri::AppHandle) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { app });
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    // Recognizer + Delegate müssen am Leben bleiben (setDelegate hält nur weak).
    static ACTIVE: RefCell<Option<(Retained<NSSpeechRecognizer>, Retained<WakeDelegate>)>> =
        const { RefCell::new(None) };
}

fn start_on_main(app: tauri::AppHandle, phrases: Vec<String>) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Nicht auf dem Main-Thread")?;
    stop_on_main();

    let recognizer: Option<Retained<NSSpeechRecognizer>> =
        unsafe { msg_send![NSSpeechRecognizer::alloc(), init] };
    let recognizer = recognizer
        .ok_or("NSSpeechRecognizer ist auf diesem System nicht verfügbar.")?;

    let commands: Vec<Retained<NSString>> = phrases
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(NSString::from_str)
        .collect();
    if commands.is_empty() {
        return Err("Keine Wake-Word-Phrase angegeben.".into());
    }
    let delegate = WakeDelegate::new(mtm, app);
    recognizer.setCommands(Some(&NSArray::from_retained_slice(&commands)));
    recognizer.setListensInForegroundOnly(false);
    recognizer.setBlocksOtherRecognizers(false);
    recognizer.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    recognizer.startListening();
    ACTIVE.with(|c| *c.borrow_mut() = Some((recognizer, delegate)));
    Ok(())
}

fn stop_on_main() {
    ACTIVE.with(|c| {
        if let Some((recognizer, _delegate)) = c.borrow_mut().take() {
            recognizer.stopListening();
        }
    });
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

#[tauri::command]
pub fn wake_word_start(app: tauri::AppHandle, phrases: Vec<String>) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || start_on_main(app2, phrases))?
}

#[tauri::command]
pub fn wake_word_stop(app: tauri::AppHandle) -> Result<(), String> {
    on_main(&app, stop_on_main)
}
