---
name: mac-mail-notizen
description: Ungelesene Mails vorlesen, Mails entwerfen und Notizen anlegen — via AppleScript über run_terminal.
---

# Mail & Notizen

Über `run_terminal` mit `osascript`. Erster Zugriff je App löst die einmalige macOS-Freigabe aus („Otto möchte Mail steuern“).

## Ungelesene Mails (Betreff + Absender)

```
osascript -e 'tell application "Mail" to get {subject, sender} of (messages of inbox whose read status is false)'
```

Nur zählen: `osascript -e 'tell application "Mail" to get unread count of inbox'`

## Mail-Entwurf anlegen (NICHT automatisch senden)

```
osascript -e 'tell application "Mail" to make new outgoing message with properties {subject:"Betreff", content:"Text", visible:true}'
```

Empfänger ergänzen:

```
osascript -e 'tell application "Mail" to tell (make new outgoing message with properties {subject:"Betreff", content:"Text", visible:true}) to make new to recipient with properties {address:"mail@example.com"}'
```

WICHTIG: Entwürfe nur SICHTBAR anlegen (visible:true) und den Nutzer selbst senden lassen — sende nie ohne ausdrückliche Bestätigung.

## Notiz anlegen

```
osascript -e 'tell application "Notes" to make new note at folder "Notes" with properties {name:"Titel", body:"Inhalt"}'
```

## Stolperfallen

- Große Postfächer: `whose read status is false` kann bei riesigen Inboxen langsam sein — background=true nutzen, wenn es länger dauert.
- Mail-Inhalte sind privat: fasse mündlich knapp zusammen, zeig Volltexte nur auf Wunsch als Artefakt.
