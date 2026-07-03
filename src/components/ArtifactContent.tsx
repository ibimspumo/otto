// Gemeinsame Inhalts-Renderer für Artefakte — genutzt von Quick Look
// (Vollansicht) und, in skalierter Form, von den Drop-Miniaturen.
// Grundsatz: Jeder Artefakt-Typ wird ECHT gerendert (Markdown als
// Dokument, Mermaid als Diagramm, Bilder als Bilder), nie als
// Rohtext-Ausschnitt.

import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Artifact, ImageState } from "../lib/types";

marked.setOptions({ gfm: true, breaks: true });

type MermaidApi = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        themeVariables: {
          background: "#0f0f13",
          mainBkg: "#17171c",
          primaryColor: "#17171c",
          primaryTextColor: "rgba(255,255,255,0.92)",
          primaryBorderColor: "rgba(255,255,255,0.16)",
          lineColor: "rgba(255,255,255,0.54)",
          textColor: "rgba(255,255,255,0.86)",
          clusterBkg: "rgba(255,255,255,0.045)",
          clusterBorder: "rgba(255,255,255,0.13)",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

export type ImageAction = "favorite" | "delete" | "save";

/** Links aus Artefakten öffnen immer im Standard-Browser. */
export function handleLinkClick(e: React.MouseEvent) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (anchor && /^https?:/.test(anchor.href)) {
    e.preventDefault();
    openUrl(anchor.href).catch(() => {});
  }
}

function resolveMarkdownImages(
  content: string,
  images: Record<string, ImageState> = {},
): string {
  return content.replace(
    /!\[([^\]]*)\]\((otto-image|gallery):([^) \t]+)(?:\s+"([^"]*)")?\)/g,
    (match, alt: string, _scheme: string, id: string, title?: string) => {
      const src = images[id]?.url;
      if (!src) return match;
      const quotedTitle = title ? ` "${title.replace(/"/g, "&quot;")}"` : "";
      return `![${alt}](${src}${quotedTitle})`;
    },
  );
}

function sanitizeMarkdownHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset):|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
}

function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    ADD_TAGS: [
      "svg",
      "g",
      "path",
      "rect",
      "circle",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "marker",
      "defs",
      "text",
      "tspan",
      "style",
    ],
    ADD_ATTR: [
      "viewBox",
      "xmlns",
      "d",
      "x",
      "y",
      "x1",
      "x2",
      "y1",
      "y2",
      "cx",
      "cy",
      "r",
      "rx",
      "ry",
      "points",
      "marker-end",
      "marker-start",
      "text-anchor",
      "dominant-baseline",
      "class",
      "style",
    ],
  });
}

export function MarkdownBody({
  content,
  images,
}: {
  content: string;
  images?: Record<string, ImageState>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(
    () =>
      sanitizeMarkdownHtml(
        marked.parse(resolveMarkdownImages(content, images), {
          async: false,
        }) as string,
      ),
    [content, images],
  );

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;
    const blocks = Array.from(
      root.querySelectorAll<HTMLElement>("pre > code.language-mermaid"),
    );
    if (blocks.length === 0) return;
    void loadMermaid().then((mermaid) => {
      blocks.forEach((code, index) => {
        const source = code.textContent ?? "";
        const pre = code.parentElement;
        if (!source.trim() || !pre) return;
        const id = `otto-mermaid-${Date.now().toString(36)}-${index}`;
        mermaid
          .render(id, source)
          .then(({ svg }) => {
            if (cancelled) return;
            const wrap = document.createElement("div");
            wrap.className = "mermaid-chart";
            wrap.innerHTML = sanitizeMermaidSvg(svg);
            pre.replaceWith(wrap);
          })
          .catch(() => {
            if (!cancelled) pre.classList.add("mermaid-error");
          });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  return (
    <div
      ref={ref}
      className="md-body"
      onClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function SearchResults({ artifact }: { artifact: Artifact }) {
  return (
    <div className="search-list">
      <p className="search-query">
        Suche nach <b>„{artifact.content}“</b>
      </p>
      {(artifact.results ?? []).map((r, i) => {
        const host = r.host || safeHost(r.url);
        return (
          <div className={`search-result ${r.thumbnail ? "with-thumb" : ""}`} key={i}>
            {r.thumbnail && (
              <button
                className="search-thumb"
                onClick={() => openUrl(r.url).catch(() => {})}
                aria-label={`${r.title} öffnen`}
              >
                <img src={r.thumbnail} alt="" loading="lazy" />
                {r.duration && <span className="search-duration">{r.duration}</span>}
              </button>
            )}
            <div className="search-result-body">
              <div className="src">
                <Favicon host={host} />
                <span>{host}</span>
                {r.age && <span className="age">{r.age}</span>}
              </div>
              <h3>
                <a
                  href={r.url}
                  onClick={(e) => {
                    e.preventDefault();
                    openUrl(r.url).catch(() => {});
                  }}
                >
                  {r.title}
                </a>
              </h3>
              {r.description && <p>{r.description}</p>}
            </div>
          </div>
        );
      })}
      {(artifact.results ?? []).length === 0 && (
        <p className="search-empty">Keine Treffer.</p>
      )}
    </div>
  );
}

export function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Kleines Favicon zum Suchtreffer — verschwindet still, wenn es fehlt. */
export function Favicon({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  if (!host || failed) return null;
  return (
    <img
      className="favicon"
      src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
      alt=""
      width={12}
      height={12}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function ImageGrid({
  ids,
  images,
  onAction,
}: {
  ids: string[];
  images: Record<string, ImageState>;
  onAction: (id: string, action: ImageAction) => void;
}) {
  const [zoomId, setZoomId] = useState<string | null>(null);
  const zoomed = zoomId ? images[zoomId] : null;

  return (
    <>
      <div className={`img-grid ${ids.length === 1 ? "single" : ""}`}>
        {ids.map((id) => {
          const st = images[id];
          const status = st?.status ?? "generating";
          return (
            <figure key={id} className={`img-cell ${status}`}>
              <div className="img-frame">
                {st?.url ? (
                  <img
                    src={st.url}
                    alt={st.meta?.name ?? "Generiertes Bild"}
                    onClick={() => status === "done" && setZoomId(id)}
                  />
                ) : (
                  <div className="img-placeholder" />
                )}
                {status === "generating" && <div className="img-life" />}
                {status === "error" && (
                  <div className="img-error">{st?.error ?? "Fehler"}</div>
                )}
              </div>
              <figcaption>
                <span className="img-name" title={st?.meta?.prompt}>
                  {status === "generating" ? "wird erzeugt…" : (st?.meta?.name ?? id)}
                </span>
                {status === "done" && st?.meta && (
                  <span className="img-actions">
                    <button
                      title={st.meta.favorite ? "Favorit entfernen" : "Favorit"}
                      className={st.meta.favorite ? "fav on" : "fav"}
                      onClick={() => onAction(id, "favorite")}
                    >
                      ★
                    </button>
                    <button
                      title="Auf dem Schreibtisch speichern"
                      onClick={() => onAction(id, "save")}
                    >
                      ↓
                    </button>
                    <button title="Löschen" onClick={() => onAction(id, "delete")}>
                      ×
                    </button>
                  </span>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {zoomed?.url && (
        <div className="img-lightbox" onClick={() => setZoomId(null)}>
          <img src={zoomed.url} alt={zoomed.meta?.name ?? ""} />
        </div>
      )}
    </>
  );
}

/** Vollansicht eines Artefakts (Quick-Look-Inhalt). */
export function ArtifactBody({
  artifact,
  images,
  onImageAction,
}: {
  artifact: Artifact;
  images: Record<string, ImageState>;
  onImageAction: (id: string, action: ImageAction) => void;
}) {
  switch (artifact.kind) {
    case "image": {
      const ids = artifact.imageIds ?? [];
      // Ein einzelnes Bild füllt das Fenster randlos — das Fenster hat
      // bereits die Aspect Ratio des Bildes.
      if (ids.length === 1) {
        const st = images[ids[0]];
        return (
          <div className={`ql-image ${st?.status ?? "generating"}`}>
            {st?.url ? (
              <img src={st.url} alt={st.meta?.name ?? artifact.title} />
            ) : (
              <div className="img-placeholder" />
            )}
            {st?.status === "generating" && <div className="img-life" />}
            {st?.status === "error" && (
              <div className="img-error">{st?.error ?? "Fehler"}</div>
            )}
          </div>
        );
      }
      return (
        <div className="ql-scroll">
          <ImageGrid ids={ids} images={images} onAction={onImageAction} />
        </div>
      );
    }
    case "markdown":
      return (
        <div className="ql-scroll doc">
          <MarkdownBody content={artifact.content} images={images} />
        </div>
      );
    case "code":
      return (
        <div className="ql-scroll">
          <pre className="code-body">{artifact.content}</pre>
        </div>
      );
    case "search":
      return (
        <div className="ql-scroll">
          <SearchResults artifact={artifact} />
        </div>
      );
    case "job":
      return <JobTerminal artifact={artifact} />;
  }
}

const JOB_STATUS_LABEL: Record<string, string> = {
  running: "läuft",
  done: "fertig",
  error: "fehlgeschlagen",
  cancelled: "abgebrochen",
};

/**
 * Gläserner Job: das Live-Terminal eines Hintergrund-Jobs in voller
 * Größe — Scrollback klebt am Ende, solange der Nutzer nicht selbst
 * hochgescrollt hat.
 */
function JobTerminal({ artifact }: { artifact: Artifact }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const lines = artifact.jobLines ?? [];

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, artifact.jobStatus]);

  return (
    <div className="job-term">
      <div className="job-term-meta">
        <span className={`job-status ${artifact.jobStatus ?? "running"}`}>
          {JOB_STATUS_LABEL[artifact.jobStatus ?? "running"]}
          {artifact.jobStatus !== "running" && artifact.exitCode != null
            ? ` · Exit ${artifact.exitCode}`
            : ""}
        </span>
        <span className="job-task" title={artifact.content}>
          {artifact.content}
        </span>
      </div>
      <div
        className="job-term-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <pre className="job-term-body">
          {lines.length > 0 ? lines.join("\n") : "— noch keine Ausgabe —"}
        </pre>
      </div>
      {artifact.jobStatus === "running" && <div className="job-term-life" aria-hidden />}
    </div>
  );
}
