import { useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  ArtifactBody,
  Favicon,
  MarkdownBody,
  safeHost,
  type ImageAction,
} from "./components/ArtifactContent";
import {
  DROP_W,
  layoutDrops,
  layoutEdgeTab,
  layoutQuickLook,
  type PresentationPlacement,
} from "./lib/hudWindow";
import * as api from "./lib/tauriApi";
import type { Artifact, ImageState } from "./lib/types";

/** Zustand, den das Hauptfenster (der Orchestrator) hierher spiegelt. */
interface PanelState {
  artifacts: Artifact[];
  activeId: string | null;
  images: Record<string, ImageState>;
}

/**
 * stack     — der sichtbare Drop-Stapel unten links
 * tucked    — zurückgezogen: nur ein schmaler Leucht-Tab an der Kante
 * quicklook — Großansicht eines Artefakts
 */
type Mode = "stack" | "tucked" | "quicklook";

/** Ruhezeit, nach der sich der Stapel von selbst zurückzieht. */
const TUCK_AFTER_MS = 10_000;
type PresentMode = "gross" | "riesig" | "klein";
type QuickLookSize = "normal" | "large";

// ------------------------------------------------------------------
// Stapel-Geometrie: deterministisch berechnet, damit das Fenster exakt
// so hoch ist wie sein Inhalt (kein unsichtbarer Klick-Fresser).
// ------------------------------------------------------------------

const HERO_HEAD = 30;
const ROW_H = 44;
const GAP = 10;
const CHIP_H = 24;

function parseSize(size?: string): { w: number; h: number } | null {
  if (!size) return null;
  const [w, h] = size.split("x").map((v) => parseInt(v, 10));
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Höhe der Hero-Vorschau — Bilder bekommen ihre echte Aspect Ratio. */
function heroPreviewHeight(
  a: Artifact,
  images: Record<string, ImageState>,
): number {
  if (a.kind === "image") {
    const first = (a.imageIds ?? [])[0];
    const st = first ? images[first] : undefined;
    const dims = parseSize(st?.meta?.size ?? st?.size);
    if (dims) {
      return Math.round(Math.min(240, Math.max(120, DROP_W * (dims.h / dims.w))));
    }
    return 190;
  }
  return 148;
}

function stackHeight(
  artifacts: Artifact[],
  images: Record<string, ImageState>,
): number {
  if (artifacts.length === 0) return ROW_H;
  const hero = artifacts[artifacts.length - 1];
  const rows = Math.min(3, artifacts.length - 1);
  const overflow = artifacts.length - 1 - rows;
  return (
    HERO_HEAD +
    heroPreviewHeight(hero, images) +
    rows * (ROW_H + GAP) +
    (overflow > 0 ? CHIP_H + GAP : 0)
  );
}

/** Gewünschte Quick-Look-Größe je Artefakt-Typ (logische Punkte). */
function desiredQuickLook(
  a: Artifact,
  images: Record<string, ImageState>,
  size: QuickLookSize = "normal",
): { w: number; h: number } {
  const boost = size === "large" ? 1.25 : 1;
  switch (a.kind) {
    case "image": {
      const ids = a.imageIds ?? [];
      if (ids.length === 1) {
        const st = images[ids[0]];
        const dims = parseSize(st?.meta?.size ?? st?.size);
        if (dims) {
          // Normal: natürliche Retina-Darstellungsgröße. Riesig: echte
          // Pixelmaße, vom Fensterlayout an den Bildschirm angepasst.
          const divisor = size === "large" ? 1 : 2;
          return {
            w: Math.max(380, dims.w / divisor),
            h: Math.max(300, dims.h / divisor),
          };
        }
        return { w: 720 * boost, h: 560 * boost };
      }
      return { w: 960 * boost, h: 660 * boost };
    }
    case "search":
      return { w: 680 * boost, h: 760 * boost };
    case "job":
      return { w: 760 * boost, h: 540 * boost };
    default:
      return { w: 720 * boost, h: 680 * boost };
  }
}

function preferredPlacement(a: Artifact): PresentationPlacement {
  if (a.kind === "search") return "rightShelf";
  return "center";
}

// ------------------------------------------------------------------
// Miniatur-Vorschauen: jeder Typ ECHT gerendert, nie Rohtext.
// ------------------------------------------------------------------

function DropPreview({
  artifact,
  images,
}: {
  artifact: Artifact;
  images: Record<string, ImageState>;
}) {
  switch (artifact.kind) {
    case "image": {
      const ids = artifact.imageIds ?? [];
      const st = ids[0] ? images[ids[0]] : undefined;
      return (
        <div className="mini-image">
          {st?.url ? (
            <img src={st.url} alt={artifact.title} />
          ) : (
            <div className="img-placeholder" />
          )}
          {ids.length > 1 && <span className="mini-more">+{ids.length - 1}</span>}
          {st?.status === "error" && (
            <div className="img-error">{st.error ?? "Fehler"}</div>
          )}
        </div>
      );
    }
    case "markdown":
      return (
        <div className="mini-doc" aria-hidden>
          <div className="mini-doc-scale">
            <MarkdownBody content={artifact.content} images={images} />
          </div>
        </div>
      );
    case "code":
      return (
        <div className="mini-code" aria-hidden>
          <pre>{artifact.content.slice(0, 1600)}</pre>
        </div>
      );
    case "search":
      return (
        <div className="mini-search">
          {(artifact.results ?? []).slice(0, 3).map((r, i) => {
            const host = r.host || safeHost(r.url);
            return (
              <p key={i} className="mini-hit">
                <Favicon host={host} />
                <b>{r.title}</b>
                <span>{host}</span>
              </p>
            );
          })}
        </div>
      );
    case "job": {
      const lines = artifact.jobLines ?? [];
      const tail = lines.slice(-5);
      return (
        <div className="mini-term" aria-hidden>
          {tail.length > 0 ? (
            tail.map((l, i) => (
              <p key={`${lines.length}-${i}`} className="mini-term-line">
                {l}
              </p>
            ))
          ) : (
            <p className="mini-term-line dim">
              {artifact.jobStatus === "running" ? "startet…" : "keine Ausgabe"}
            </p>
          )}
        </div>
      );
    }
  }
}

const KIND_LABEL: Record<Artifact["kind"], string> = {
  markdown: "Dokument",
  code: "Code",
  search: "Suche",
  image: "Bild",
  job: "Job",
};

/** "Arbeitet noch": hält Lebensader an, verhindert Ablauf und Zurückziehen. */
function isGenerating(a: Artifact, images: Record<string, ImageState>): boolean {
  if (a.kind === "job") return a.jobStatus === "running";
  return (
    a.kind === "image" &&
    (a.imageIds ?? []).some((id) => images[id]?.status === "generating")
  );
}

// ------------------------------------------------------------------
// Das Panel: Drop-Stapel unten links, Quick Look zentriert.
// ------------------------------------------------------------------

export default function PanelApp() {
  const [state, setState] = useState<PanelState>({
    artifacts: [],
    activeId: null,
    images: {},
  });
  const [mode, setMode] = useState<Mode>("stack");
  const [qlId, setQlId] = useState<string | null>(null);
  const [qlSize, setQlSize] = useState<QuickLookSize>("normal");
  // Maus über dem Stapel? Dann zieht er sich nicht zurück.
  const [hovered, setHovered] = useState(false);
  // Remount-Schlüssel: beim Hervorkommen aus dem Tab bauen sich die
  // Karten gestaffelt neu auf (Animationen laufen erneut).
  const [revealKey, setRevealKey] = useState(0);
  // Quick-Look-Wunsch per Stimme, dessen Artefakt noch nicht im
  // gespiegelten Zustand angekommen ist — wird beim nächsten Update eingelöst.
  const [pendingQl, setPendingQl] = useState<{
    id: string;
    size: QuickLookSize;
  } | null>(null);
  const readySent = useRef(false);
  const modeRef = useRef<Mode>("stack");
  modeRef.current = mode;
  const stateRef = useRef<PanelState>(state);
  stateRef.current = state;
  const qlIdRef = useRef<string | null>(null);
  qlIdRef.current = qlId;

  useEffect(() => {
    const unState = listen<PanelState>("panel-state", (e) => setState(e.payload));
    // fresh = das Fenster war zu und geht neu auf: immer im Stapel starten.
    const unOpen = listen<{ fresh?: boolean }>("panel-open", (e) => {
      if (e.payload?.fresh) {
        setMode("stack");
        setQlId(null);
        setQlSize("normal");
      } else if (modeRef.current === "tucked") {
        // Explizit angefordert (Stimme/Insel): aus dem Tab hervorkommen.
        setRevealKey((k) => k + 1);
        setMode("stack");
      }
    });
    // Hot Corner: Maus unten links weckt den zurückgezogenen Stapel.
    const unCorner = listen("hot-corner", () => {
      if (modeRef.current === "tucked") {
        setRevealKey((k) => k + 1);
        setMode("stack");
      }
    });
    // Quick Look per Stimme (present_artifact) — wirkt wie ein Klick.
    const unPresent = listen<{ mode: PresentMode; id?: string }>(
      "panel-present",
      (e) => {
        if (e.payload.mode === "klein") {
          setMode("stack");
          setQlId(null);
          setQlSize("normal");
          setPendingQl(null);
          return;
        }
        const size = e.payload.mode === "riesig" ? "large" : "normal";
        const arts = stateRef.current.artifacts;
        const target = e.payload.id
          ? arts.find((a) => a.id === e.payload.id)
          : arts[arts.length - 1];
        if (target) {
          setQlId(target.id);
          setQlSize(size);
          setMode("quicklook");
        } else if (e.payload.id) {
          // Artefakt eilt dem panel-state-Spiegel voraus — vormerken.
          setPendingQl({ id: e.payload.id, size });
        }
      },
    );
    if (!readySent.current) {
      readySent.current = true;
      void emit("panel-ready", {});
    }
    return () => {
      unState.then((f) => f());
      unOpen.then((f) => f());
      unPresent.then((f) => f());
      unCorner.then((f) => f());
    };
  }, []);

  // Esc: Quick Look → zurück zum Stapel; Stapel → Fenster schließen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modeRef.current === "quicklook") {
        setMode("stack");
        setQlId(null);
        setQlSize("normal");
      } else {
        void emit("panel-close", {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { artifacts, images } = state;
  const hero = artifacts[artifacts.length - 1] ?? null;
  const older = artifacts.slice(0, -1);
  const rows = older.slice(-3);
  const overflow = older.length - rows.length;

  const qlArtifact = qlId
    ? (artifacts.find((a) => a.id === qlId) ?? null)
    : null;

  // Wird das Quick-Look-Artefakt geschlossen (z. B. per Stimme), fällt das
  // Fenster in den Stapel zurück.
  useEffect(() => {
    if (mode === "quicklook" && qlId && !artifacts.some((a) => a.id === qlId)) {
      setMode("stack");
      setQlId(null);
    }
  }, [mode, qlId, artifacts]);

  // Vorgemerkten Quick-Look-Wunsch einlösen, sobald das Artefakt im
  // gespiegelten Zustand angekommen ist.
  useEffect(() => {
    if (!pendingQl) return;
    if (artifacts.some((a) => a.id === pendingQl.id)) {
      setQlId(pendingQl.id);
      setQlSize(pendingQl.size);
      setMode("quicklook");
      setPendingQl(null);
    }
  }, [pendingQl, artifacts]);

  // Aufgeräumt wie Screenshots: Fertige Drops verschwinden nach 3 Minuten
  // von selbst — nie während der Generierung, nie das gerade Geöffnete.
  useEffect(() => {
    const EXPIRE_MS = 3 * 60_000;
    const tick = setInterval(() => {
      const { artifacts: arts, images: imgs } = stateRef.current;
      const now = Date.now();
      for (const a of arts) {
        if (a.id === qlIdRef.current) continue;
        if (isGenerating(a, imgs)) continue;
        // Bilder gelten ab dem Speicherzeitpunkt des letzten Bildes als
        // fertig, alles andere ab der letzten Änderung.
        const doneAt =
          a.kind === "image"
            ? Math.max(
                a.updatedAt,
                ...(a.imageIds ?? []).map(
                  (id) => imgs[id]?.meta?.created_ms ?? 0,
                ),
              )
            : a.updatedAt;
        if (now - doneAt > EXPIRE_MS) {
          void emit("panel-action", { type: "close", id: a.id });
        }
      }
    }, 15_000);
    return () => clearInterval(tick);
  }, []);

  // Stapel-Modus: Fenstergröße folgt exakt dem Inhalt.
  const stackH = useMemo(() => stackHeight(artifacts, images), [artifacts, images]);
  useEffect(() => {
    if (mode === "stack") void layoutDrops(stackH);
  }, [mode, stackH]);

  // ---- Lebenszyklus: zurückziehen & hervorkommen --------------------

  const anyGenerating = artifacts.some((a) => isGenerating(a, images));
  // Identität des Inhalts (neu/aktualisiert), unabhängig von Bild-Ticks.
  const artSig = artifacts.map((a) => `${a.id}:${a.updatedAt}`).join("|");

  // Nach Ruhezeit zieht sich der Stapel zur Kante zurück — nie während
  // etwas generiert, nie solange die Maus darüber ist.
  useEffect(() => {
    if (mode !== "stack" || hovered || anyGenerating || artifacts.length === 0) return;
    const t = setTimeout(() => setMode("tucked"), TUCK_AFTER_MS);
    return () => clearTimeout(t);
    // artSig als Dep: jede neue/aktualisierte Karte startet die Ruhezeit neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, hovered, anyGenerating, artSig]);

  // Neuer Inhalt, während der Stapel eingezogen ist → hervorkommen und zeigen.
  const prevSigRef = useRef(artSig);
  useEffect(() => {
    if (mode === "tucked" && artSig !== prevSigRef.current && artifacts.length > 0) {
      setRevealKey((k) => k + 1);
      setMode("stack");
    }
    prevSigRef.current = artSig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artSig, mode]);

  // Eingezogen: winziges Tab-Fenster + Ecken-Poller an (und wieder aus).
  useEffect(() => {
    if (mode !== "tucked") return;
    void layoutEdgeTab();
    void api.hotCornerStart().catch(() => {});
    return () => {
      void api.hotCornerStop().catch(() => {});
    };
  }, [mode]);

  // Quick Look: Fenster wächst zur Inhaltsgröße (Bilder in echter Ratio).
  useEffect(() => {
    if (mode !== "quicklook" || !qlArtifact) return;
    const want = desiredQuickLook(qlArtifact, images, qlSize);
    void layoutQuickLook(want.w, want.h, qlSize, preferredPlacement(qlArtifact));
    // Bewusst nur bei Artefakt-/Größenwechsel, nicht bei jedem images-Tick:
    // die Ratio steht schon während der Generierung fest (size).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, qlArtifact?.id, qlArtifact?.updatedAt, qlSize]);

  const openQuickLook = (a: Artifact) => {
    setQlId(a.id);
    setQlSize("normal");
    setMode("quicklook");
    void emit("panel-action", { type: "select", id: a.id });
  };

  const dismissDrop = (id: string) => {
    void emit("panel-action", { type: "close", id });
  };

  const onImageAction = (id: string, action: ImageAction) => {
    void emit("panel-action", { type: "image", id, action });
  };

  // --- Quick Look ---------------------------------------------------
  if (mode === "quicklook" && qlArtifact) {
    const copyable = qlArtifact.kind !== "image";
    return (
      <div
        className="ql-shell"
        data-kind={qlArtifact.kind}
        data-placement={preferredPlacement(qlArtifact)}
      >
        <div className="ql-bar" data-tauri-drag-region>
          <button
            className="ql-close"
            title="Zurück (Esc)"
            aria-label="Zurück zum Stapel"
            onClick={() => {
              setMode("stack");
              setQlId(null);
              setQlSize("normal");
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <span className="ql-title" data-tauri-drag-region>
            {qlArtifact.title}
          </span>
          <span className="ql-actions">
            {copyable && (
              <button
                onClick={() =>
                  navigator.clipboard.writeText(qlArtifact.content).catch(() => {})
                }
              >
                Kopieren
              </button>
            )}
          </span>
        </div>
        <div className="ql-content">
          <ArtifactBody
            artifact={qlArtifact}
            images={images}
            onImageAction={onImageAction}
          />
        </div>
      </div>
    );
  }

  // --- Leucht-Tab (zurückgezogen) -------------------------------------
  if (mode === "tucked") {
    return (
      <div
        className="edge-tab"
        role="button"
        aria-label={`${artifacts.length} Ergebnisse zeigen`}
        title="Ergebnisse zeigen"
        onMouseEnter={() => {
          setRevealKey((k) => k + 1);
          setMode("stack");
        }}
        onClick={() => {
          setRevealKey((k) => k + 1);
          setMode("stack");
        }}
      >
        <span className="edge-tab-light" aria-hidden />
      </div>
    );
  }

  // --- Drop-Stapel ---------------------------------------------------
  return (
    <div
      className="drops"
      key={revealKey}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {overflow > 0 && (
        <div className="drop-chip">{overflow} weitere im Stapel</div>
      )}
      {rows.map((a) => (
        <div key={a.id} className="drop row" onClick={() => openQuickLook(a)}>
          <span className="drop-kind">{KIND_LABEL[a.kind]}</span>
          <span className="drop-row-title">{a.title}</span>
          <button
            className="drop-close"
            title="Verwerfen"
            aria-label={`${a.title} verwerfen`}
            onClick={(e) => {
              e.stopPropagation();
              dismissDrop(a.id);
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
      {hero && (
        <div
          key={hero.id}
          className={`drop hero ${isGenerating(hero, images) ? "generating" : ""}`}
          onClick={() => openQuickLook(hero)}
          title="Klicken zum Vergrößern"
        >
          <div className="drop-head">
            <span className="drop-kind">{KIND_LABEL[hero.kind]}</span>
            <span className="drop-title">{hero.title}</span>
            <button
              className="drop-close"
              title="Verwerfen"
              aria-label={`${hero.title} verwerfen`}
              onClick={(e) => {
                e.stopPropagation();
                dismissDrop(hero.id);
              }}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div
            className="drop-preview"
            style={{ height: heroPreviewHeight(hero, images) }}
          >
            <DropPreview
              artifact={hero}
              images={images}
            />
          </div>
          {/* Die Lebensader: 2px Zustandslicht, solange generiert wird. */}
          <div className="drop-life" aria-hidden />
        </div>
      )}
    </div>
  );
}
