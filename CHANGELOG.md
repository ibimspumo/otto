# Changelog

Alle nennenswerten Änderungen an Otto. Format lose nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [SemVer](https://semver.org/lang/de/).

## [0.1.3] — 2026-07-02

### Diagnose & Guards ohne Apple-Signing

- **App-Identitäts-Diagnose** (`diagnostics.rs`): erkennt beim Start die
  häufigsten TCC-Fehlzustände unsignierter Builds — App Translocation
  (Gatekeeper Path Randomization), lose Dev-/Debug-Binaries und gesetzte
  Quarantäne — und loggt sie ins interne Diagnose-Log.
- **Handlungshinweis im Frontend**: Die Einstellungen zeigen einen neuen
  Diagnose-Abschnitt mit App-Pfad, Bundle-ID und dem TCC-Status
  (Bildschirmaufnahme, Bedienungshilfen). Bei Translocation/Dev-Build
  bekommt der Nutzer den klaren Rat, die App nach `/Applications` zu
  verschieben, die Quarantäne zu entfernen und neu zu starten.
- **Dialogfreie Preflight-Prüfung** (`permissions::preflight`): meldet den
  aktuellen TCC-Stand, ohne einen macOS-Berechtigungsdialog auszulösen —
  Grundlage für Diagnose, Logging und den Computer-Use-Standort-Check.

[0.1.3]: https://github.com/ibimspumo/otto/releases/tag/v0.1.3
[0.1.2]: https://github.com/ibimspumo/otto/releases/tag/v0.1.2
[0.1.0]: https://github.com/ibimspumo/otto/releases/tag/v0.1.0
