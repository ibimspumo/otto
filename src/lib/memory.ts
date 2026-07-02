// Automatisches Gedächtnis: Memory-Flush + Konsolidierung („Dreaming").
//
// Flush (Session-Ende): Ein stiller, billiger Chat-Completions-Call
// extrahiert bleibende Fakten aus dem Transkript in die Tagesnotiz.
// Der Voice-Agent ist daran nicht beteiligt — kein Latenz-Impact.
//
// Dreaming (App-Start, Catch-up): Verpasste Flushes nachholen, dann —
// wenn die letzte Konsolidierung >20 h her ist — Tagesnotizen sichten
// und nur Wiederkehrendes nach MEMORY.md/USER.md promoten. Danach
// werden alte Roh-Transkripte und Notizen aufgeräumt.

import * as api from "./tauriApi";
import type { Settings, TranscriptItem } from "./types";

/** Hartes Budget gegen Memory-Bloat (Hermes-Ansatz). */
export const MEMORY_BUDGET_CHARS = 2600;

const FLUSH_SYSTEM = `Du bist das Gedächtnismodul des Sprachassistenten Otto.
Du bekommst das Transkript einer gerade beendeten Sprachsitzung zwischen dem Nutzer und Otto.
Extrahiere NUR bleibende Informationen, die für künftige Sitzungen wichtig sind:
- Fakten über den Nutzer (Name, Projekte, Vorlieben, Gewohnheiten, Setup)
- getroffene Entscheidungen und Vereinbarungen
- laufende Vorhaben mit Stand
Regeln:
- Deutsch, stichpunktartig, eine Zeile pro Fakt, beginnend mit "- ".
- Keine Small-Talk-Inhalte, nichts Einmaliges ohne Zukunftswert, keine Zusammenfassung des Gesprächs.
- Wandle relative Zeitangaben in absolute um (heute = {DATE}).
- Wenn nichts Bleibendes dabei ist, antworte exakt: NO_REPLY`;

const CONSOLIDATE_SYSTEM = `Du bist das Konsolidierungsmodul („Dreaming") des Sprachassistenten Otto.
Du bekommst: die aktuelle MEMORY.md (kuratiertes Langzeitgedächtnis), die aktuelle USER.md (Nutzerprofil) und die rohen Tagesnotizen der letzten Tage.
Deine Aufgabe: Beide Dateien aktualisiert zurückgeben.
Regeln:
- Promote nur, was mehrfach auftaucht oder klar dauerhaft wichtig ist (Namen, Projekte, feste Vorlieben, Setup). Einmal-Erwähnungen bleiben draußen.
- Fasse Überlappendes zusammen, entferne Veraltetes und Widersprüchliches (neuere Information gewinnt).
- MEMORY.md: maximal ${MEMORY_BUDGET_CHARS} Zeichen, Stichpunkte mit Datum ([JJJJ-MM-TT]). Struktur und Überschrift beibehalten.
- USER.md: Profil-Struktur beibehalten und Felder ergänzen/präzisieren — nichts erfinden.
- Persona-Dateien (SOUL.md) fasst du NIE an.
- Antworte ausschließlich mit JSON: {"memory_md": "…", "user_md": "…"} — keine Erklärungen, kein Markdown-Codeblock.`;

async function chatCompletion(
  settings: Settings,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openai_api_key.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.memory_model?.trim() || "gpt-5-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_completion_tokens: maxTokens,
    }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(
      json?.error?.message ?? `Memory-Call fehlgeschlagen (HTTP ${resp.status})`,
    );
  }
  return String(json?.choices?.[0]?.message?.content ?? "").trim();
}

function transcriptToText(items: { role: string; text: string }[]): string {
  return items
    .map((t) => `${t.role === "user" ? "NUTZER" : "OTTO"}: ${t.text}`)
    .join("\n")
    .slice(-24_000);
}

/**
 * Memory-Flush für ein Transkript: Fakten in die Tagesnotiz des
 * angegebenen Datums schreiben. Liefert true, wenn etwas Bleibendes
 * extrahiert wurde.
 */
async function flushTranscript(
  settings: Settings,
  transcript: string,
  date?: string,
): Promise<boolean> {
  if (transcript.trim().length < 80) return false;
  const today = new Date().toISOString().slice(0, 10);
  const system = FLUSH_SYSTEM.replace("{DATE}", date ?? today);
  const result = await chatCompletion(settings, system, transcript, 900);
  if (!result || result === "NO_REPLY" || result.includes("NO_REPLY")) {
    return false;
  }
  await api.memoryNoteAppend(result, date);
  return true;
}

/** Flush der gerade beendeten Live-Session (fire-and-forget beim Disconnect). */
export async function flushSession(
  settings: Settings,
  sessionId: number | null,
  items: TranscriptItem[],
): Promise<void> {
  if (!settings.memory_enabled || !settings.openai_api_key.trim()) return;
  const finals = items.filter((t) => t.final && t.text.trim());
  if (finals.length < 2) {
    // Nichts Substanzielles — Session trotzdem als verarbeitet markieren.
    if (sessionId !== null) await api.sessionMarkProcessed(sessionId).catch(() => {});
    return;
  }
  try {
    await flushTranscript(settings, transcriptToText(finals));
    if (sessionId !== null) await api.sessionMarkProcessed(sessionId);
  } catch {
    // Fehlgeschlagen (z. B. offline): Session bleibt unverarbeitet,
    // der Catch-up beim nächsten App-Start holt den Flush nach.
  }
}

function msToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface DreamingReport {
  flushed: number;
  consolidated: boolean;
  cleaned: number;
}

/**
 * Catch-up-Job beim App-Start. Läuft komplett im Hintergrund und darf
 * beliebig scheitern — beim nächsten Start wird erneut aufgeholt.
 */
export async function runDreaming(
  settings: Settings,
  onStatus?: (text: string) => void,
): Promise<DreamingReport> {
  const report: DreamingReport = { flushed: 0, consolidated: false, cleaned: 0 };
  if (!settings.memory_enabled || !settings.openai_api_key.trim()) return report;

  // 1) Verpasste Memory-Flushes nachholen (Sessions, die ohne Flush
  //    endeten — App-Absturz, offline, …).
  try {
    const pending = await api.sessionsUnprocessed();
    for (const s of pending) {
      if (s.transcript.trim().length < 80) {
        await api.sessionMarkProcessed(s.id);
        continue;
      }
      onStatus?.("holt Gedächtnis-Notizen nach…");
      try {
        await flushTranscript(settings, s.transcript, msToDate(s.started_ms));
        await api.sessionMarkProcessed(s.id);
        report.flushed += 1;
      } catch {
        break; // offline o. Ä. — nächster App-Start versucht es erneut
      }
    }
  } catch {
    // Ohne DB-Zugriff kein Catch-up.
  }

  // 2) Konsolidierung, wenn fällig (>20 h) und es neue Notizen gibt.
  try {
    const state = await api.memoryStateGet();
    const last = Number(state.last_consolidation_ms ?? 0);
    const due = Date.now() - last > 20 * 60 * 60 * 1000;
    if (due) {
      const notes = await api.memoryNotesRecent(14);
      if (notes.trim().length > 60) {
        onStatus?.("konsolidiert das Langzeitgedächtnis…");
        const memoryMd = await api.readAgentFile("MEMORY.md");
        const userMd = await api.readAgentFile("USER.md");
        const raw = await chatCompletion(
          settings,
          CONSOLIDATE_SYSTEM,
          `--- MEMORY.md ---\n${memoryMd}\n\n--- USER.md ---\n${userMd}\n\n--- Tagesnotizen ---\n${notes}`,
          4000,
        );
        const cleaned = raw.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
        const parsed = JSON.parse(cleaned) as {
          memory_md?: string;
          user_md?: string;
        };
        // Nur plausible Ergebnisse übernehmen — nie Dateien leeren.
        if (
          typeof parsed.memory_md === "string" &&
          parsed.memory_md.trim().length > 20
        ) {
          await api.writeAgentFile(
            "MEMORY.md",
            parsed.memory_md.slice(0, MEMORY_BUDGET_CHARS + 400).trim() + "\n",
          );
        }
        if (typeof parsed.user_md === "string" && parsed.user_md.trim().length > 20) {
          await api.writeAgentFile("USER.md", parsed.user_md.trim() + "\n");
        }
        report.consolidated = true;
      }
      await api.memoryStateSet({
        ...state,
        last_consolidation_ms: Date.now(),
      });
    }
  } catch {
    // Konsolidierung ist Komfort — nie die App stören.
  }

  // 3) Aufräumen: alte Roh-Transkripte und Tagesnotizen.
  try {
    const days = settings.session_retention_days || 30;
    report.cleaned = await api.sessionsCleanup(days);
    await api.memoryNotesCleanup(Math.max(days, 30));
  } catch {
    // Aufräumen darf still scheitern.
  }
  return report;
}
