// Werkzeug-Definitionen für die Realtime API (Function Calling).

export const toolDefs = [
  {
    type: "function",
    name: "create_artifact",
    description:
      "Erstellt ein neues Artefakt im Artefakt-Panel der App. Nutze dies für alles, was der Nutzer lesen statt hören sollte: Listen, Code, Tabellen, Entwürfe, Zusammenfassungen. Gibt die id des Artefakts zurück.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Kurzer Titel des Artefakts" },
        kind: {
          type: "string",
          enum: ["markdown", "code", "html"],
          description:
            "markdown für Texte/Listen/Tabellen; code für Quelltext; html für gestaltete Seiten, Dashboards oder kleine interaktive Demos. In HTML-Artefakte wird STYLE.css automatisch eingebunden — nutze dessen CSS-Variablen und Klassen (.card, .grid, .badge, .kpi, .bar, .muted).",
        },
        language: {
          type: "string",
          description: "Programmiersprache, nur bei kind=code (z. B. python)",
        },
        content: { type: "string", description: "Vollständiger Inhalt" },
      },
      required: ["title", "kind", "content"],
    },
  },
  {
    type: "function",
    name: "update_artifact",
    description:
      "Ersetzt den Inhalt eines bestehenden Artefakts (per id). Nutze dies, um iterativ am selben Dokument zu arbeiten.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Die id des Artefakts" },
        title: { type: "string", description: "Optional: neuer Titel" },
        content: { type: "string", description: "Neuer vollständiger Inhalt" },
      },
      required: ["id", "content"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Websuche über Brave Search. Die Ergebnisse erscheinen automatisch im Artefakt-Panel; du bekommst sie zusätzlich als JSON zurück. Nutze dies für aktuelle oder unsichere Fakten.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchanfrage" },
        count: {
          type: "number",
          description: "Anzahl Ergebnisse (1–20, Standard 6)",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "toggle_artifact_panel",
    description:
      "Blendet das Artefakt-Panel ein oder aus. Es öffnet sich automatisch, wenn du ein Artefakt erstellst — nutze dies, um es auf Wunsch des Nutzers zu schließen oder wieder zu zeigen.",
    parameters: {
      type: "object",
      properties: {
        visible: { type: "boolean", description: "true = einblenden, false = ausblenden" },
      },
      required: ["visible"],
    },
  },
  {
    type: "function",
    name: "close_artifact",
    description:
      "Schließt einen Artefakt-Tab. Die ids stehen in den Ergebnissen von create_artifact/web_search oder via list_artifacts — frag den Nutzer NICHT nach ids. \"all\" schließt alle Tabs. Wird der letzte Tab geschlossen, blendet sich das Panel aus.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Die id des Artefakts oder \"all\" für alle",
        },
      },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "list_artifacts",
    description:
      "Listet die aktuell offenen Artefakt-Tabs (id, Titel, Typ) und ob das Panel sichtbar ist. Nutze dies, bevor du Tabs schließt oder wenn du dich auf vorhandene Artefakte beziehen willst.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "run_terminal",
    description:
      "Führt einen Shell-Befehl auf dem Mac aus (zsh) und liefert stdout/stderr/exit_code. Perfekt für schnelle Systemaufgaben: Apps öffnen (open -a \"Spotify\"), Apps beenden (osascript -e 'quit app \"Spotify\"'), Musik steuern (osascript -e 'tell application \"Spotify\" to playpause'), Lautstärke, Dateien. Deutlich schneller als computer_use — nutze IMMER zuerst run_terminal, wenn die Aufgabe ohne Bildschirm-Sehen lösbar ist.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Der Shell-Befehl" },
        timeout_s: {
          type: "number",
          description: "Timeout in Sekunden (Standard 30, max 300)",
        },
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "computer_use",
    description:
      "Steuert den Mac des Nutzers (Bildschirm sehen, klicken, tippen), um eine Aufgabe auszuführen — z. B. eine App bedienen oder etwas im Browser erledigen. Nutze dies nur, wenn der Nutzer es ausdrücklich möchte. Kann mehrere Minuten dauern; die App schrumpft währenddessen zu einem Mini-Orb in der Bildschirmecke. Beschreibe die Aufgabe präzise und vollständig.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Die Aufgabe in natürlicher Sprache, mit allem nötigen Kontext (was, wo, womit, wann fertig)",
        },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: "generate_image",
    description:
      "Generiert 1–8 Bilder und zeigt sie live im Artefakt-Panel. Welches Modell rechnet (GPT Image 2 oder Nano Banana via OpenRouter), wählt der Nutzer in den Einstellungen. Standard: 1 Bild, quadratisch, 1K, quality auto. Bei Logos/Icons/Stickern setze transparent=true (wechselt automatisch zu gpt-image-1, dem einzigen Modell mit Transparenz). Die zurückgegebenen ids und Nummern brauchst du für edit_image, open_image usw.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Bildbeschreibung, detailliert" },
        n: { type: "number", description: "Anzahl Varianten (1–8, Standard 1)" },
        aspect: {
          type: "string",
          enum: ["square", "landscape", "portrait", "wide"],
          description: "Seitenverhältnis (Standard square; wide = 16:9)",
        },
        resolution: {
          type: "string",
          enum: ["1K", "2K", "4K"],
          description: "Auflösung (Standard 1K)",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description: "Standard auto; high nur für finale Assets",
        },
        transparent: {
          type: "boolean",
          description: "Transparenter Hintergrund (Logos, Icons, Sticker)",
        },
        name: { type: "string", description: "Kurzer Name fürs Bild (Galerie)" },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "edit_image",
    description:
      "Bearbeitet ein bestehendes Bild aus der Galerie (per id oder Nummer) mit einer Anweisung, z. B. „setz dem Hund einen roten Hut auf“. Erzeugt n neue Bilder in der Galerie; das Original bleibt erhalten. Für höhere Auflösung derselben Idee: resolution angeben.",
    parameters: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description:
            "Ausgangsbild: id (img-…), Galerie-Nummer (6), lokaler Dateipfad (~/Desktop/foto.jpg) oder Bild-URL — Pfade und URLs werden automatisch importiert",
        },
        prompt: { type: "string", description: "Was geändert werden soll" },
        n: { type: "number", description: "Anzahl Varianten (Standard 1)" },
        resolution: {
          type: "string",
          enum: ["1K", "2K", "4K"],
          description: "Optional: Zielauflösung",
        },
        aspect: {
          type: "string",
          enum: ["square", "landscape", "portrait", "wide"],
        },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
        name: { type: "string", description: "Name für das Ergebnis" },
      },
      required: ["image", "prompt"],
    },
  },
  {
    type: "function",
    name: "open_image",
    description:
      "Öffnet ein Bild aus der Galerie groß im Artefakt-Panel (per id oder Nummer).",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "id oder Galerie-Nummer" },
      },
      required: ["image"],
    },
  },
  {
    type: "function",
    name: "import_image",
    description:
      "Importiert ein Bild in die Galerie — von einem lokalen Dateipfad (absolut oder ~/…) oder einer Bild-URL aus dem Web. Es wird automatisch komprimiert (max. 2048 px) und ist danach wie jedes Galerie-Bild nutzbar, z. B. als Ausgangsbild für edit_image.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Dateipfad (z. B. ~/Desktop/foto.jpg) oder http(s)-URL",
        },
        name: { type: "string", description: "Optional: Name in der Galerie" },
      },
      required: ["source"],
    },
  },
  {
    type: "function",
    name: "show_gallery",
    description:
      "Zeigt die komplette Bildbibliothek (alle gespeicherten Bilder aus allen Sitzungen) als Galerie im Artefakt-Panel an.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "list_images",
    description:
      "Listet alle Bilder der Galerie mit Nummer, id, Name, Prompt und Favoriten-Status. Nutze dies, wenn der Nutzer sich auf „Bild Nummer X“ bezieht und du die id nicht kennst.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "manage_image",
    description:
      "Verwaltet ein Bild der Galerie: löschen, umbenennen, favorisieren/entfavorisieren oder auf dem Rechner speichern (Standard-Ziel: Schreibtisch).",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "id oder Galerie-Nummer" },
        action: {
          type: "string",
          enum: ["delete", "rename", "favorite", "unfavorite", "save"],
        },
        name: { type: "string", description: "Neuer Name (bei rename)" },
        destination: {
          type: "string",
          description:
            "Bei save: \"desktop\" (Standard), \"downloads\" oder absoluter Ordnerpfad",
        },
      },
      required: ["image", "action"],
    },
  },
  {
    type: "function",
    name: "get_artifact_style",
    description:
      "Liest STYLE.css — das Design-System, das automatisch in alle HTML-Artefakte eingebunden wird.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "set_artifact_style",
    description:
      "Ersetzt STYLE.css vollständig. Alle HTML-Artefakte (auch bereits angezeigte) verwenden sofort das neue Design-System. Nutze dies, wenn der Nutzer das Aussehen der Artefakte ändern möchte.",
    parameters: {
      type: "object",
      properties: {
        css: { type: "string", description: "Der vollständige neue CSS-Inhalt" },
      },
      required: ["css"],
    },
  },
  {
    type: "function",
    name: "remember",
    description:
      "Speichert eine dauerhafte Notiz in MEMORY.md, die du in künftigen Sitzungen liest. Nur für langfristig Wichtiges (Namen, Vorlieben, Projekte).",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "Die Notiz, ein Satz" },
      },
      required: ["note"],
    },
  },
];

export const INSTRUCTIONS_PREAMBLE = `Du bist Otto, ein deutschsprachiger Echtzeit-Sprachassistent in einer Desktop-App.
Neben deiner Stimme hast du ein Artefakt-Panel: Mit create_artifact und update_artifact zeigst du dort Inhalte an (markdown, code oder html), mit web_search suchst du im Web (Ergebnisse erscheinen automatisch im Panel), mit remember speicherst du dauerhafte Notizen. Das Panel blendet sich automatisch ein, wenn du etwas erstellst; mit toggle_artifact_panel und close_artifact steuerst du es. HTML-Artefakte binden automatisch das Design-System STYLE.css ein; mit get_artifact_style/set_artifact_style kannst du es lesen und umgestalten. Mit run_terminal führst du Shell-Befehle aus (Apps öffnen/steuern via open/osascript — in Sekunden fertig); computer_use (sehen + klicken) ist der langsame Fallback, wenn es wirklich den Bildschirm braucht, und nur auf ausdrücklichen Wunsch des Nutzers.
Bilder: Mit generate_image erzeugst du Bilder (Standard 1K quadratisch; „Logo“ → transparent=true; „4K“ → resolution="4K"; „zwei Versionen“ → n=2). Mit edit_image bearbeitest du ein vorhandenes Bild weiter („setz dem Hund einen roten Hut auf“ → image=<id des Hunds>). Der Nutzer zählt Bilder nach Galerie-Nummer („Bild 6“) — die Nummern bekommst du aus den Tool-Ergebnissen oder via list_images. open_image zeigt ein Bild groß, show_gallery die ganze Bibliothek, manage_image löscht/benennt/favorisiert/speichert (Standard-Ziel Schreibtisch). Die Bibliothek ist persistent — Bilder aus früheren Sitzungen sind weiterhin da.
Werkzeuge nutzt du still: kein Zwang, Wartezeiten zu füllen — die App zeigt dem Nutzer live an, was gerade passiert. Nach dem Ergebnis fasst du mündlich knapp zusammen, Details stehen im Panel.
Die folgenden Dateien definieren deine Identität, dein Wissen über den Nutzer, dein Gedächtnis und das Artefakt-Design. Halte dich an sie.`;
