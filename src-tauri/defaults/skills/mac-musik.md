---
name: mac-musik
description: Musik steuern (Music.app/Spotify) und den laufenden Titel nennen — via AppleScript über run_terminal.
---

# Musik steuern

Über `run_terminal` mit `osascript`. Funktioniert mit Music.app und Spotify (gleiches Vokabular).

## Grundsteuerung

```
osascript -e 'tell application "Music" to play'
osascript -e 'tell application "Music" to pause'
osascript -e 'tell application "Music" to next track'
osascript -e 'tell application "Music" to previous track'
```

## Was läuft gerade?

```
osascript -e 'tell application "Music" to get name of current track & " – " & artist of current track'
```

## Playlist abspielen

```
osascript -e 'tell application "Music" to play playlist "Fokus"'
```

Playlist-Namen auflisten: `osascript -e 'tell application "Music" to get name of every playlist'`

## Lautstärke

```
osascript -e 'set volume output volume 40'
```

## Stolperfallen

- Nutzt der Nutzer Spotify, ersetze `"Music"` durch `"Spotify"` — frag beim ersten Mal, was er nutzt, und merke es dir mit remember.
- Läuft die App nicht, startet AppleScript sie automatisch — das kann kurz dauern.
