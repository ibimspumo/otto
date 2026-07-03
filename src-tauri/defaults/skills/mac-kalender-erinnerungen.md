---
name: mac-kalender-erinnerungen
description: Kalender lesen/anlegen und Erinnerungen setzen — per AppleScript über run_terminal, ohne Zusatzdienste.
---

# Kalender & Erinnerungen steuern

Alles läuft über `run_terminal` mit `osascript`. Beim ERSTEN Zugriff fragt macOS den Nutzer einmalig („Otto möchte Kalender steuern“) — kündige das kurz an.

## Heutige Termine vorlesen

```
osascript -e 'tell application "Calendar" to get summary of every event of calendar 1 whose start date is greater than (current date) and start date is less than ((current date) + 1 * days)'
```

Für alle Kalender statt nur des ersten: iteriere mit `every calendar` (Namen zuerst via `get name of every calendar` holen).

## Termin anlegen

```
osascript -e 'tell application "Calendar" to tell calendar "Privat" to make new event with properties {summary:"Zahnarzt", start date:date "05.07.2026 09:00", end date:date "05.07.2026 10:00"}'
```

Datumsformat folgt der System-Locale (deutsch: `TT.MM.JJJJ HH:MM`). Kalendername vorher erfragen oder mit `get name of every calendar` auflisten.

## Erinnerung setzen

```
osascript -e 'tell application "Reminders" to make new reminder with properties {name:"Anruf Steuerberater", due date:date "04.07.2026 09:00"}'
```

## Erinnerungen vorlesen

```
osascript -e 'tell application "Reminders" to get name of every reminder whose completed is false'
```

## Stolperfallen

- Calendar.app muss nicht offen sein — AppleScript startet sie unsichtbar; der erste Aufruf kann 2–3 s dauern.
- Wiederkehrende Termine liefern nur das Basis-Event; für „was steht heute an“ reicht das meist trotzdem.
- Antworte mündlich kompakt (nur Zeiten + Titel), Details bei Bedarf als Markdown-Artefakt.
