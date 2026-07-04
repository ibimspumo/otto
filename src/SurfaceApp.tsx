import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ArtifactBody,
  type ImageAction,
} from "./components/ArtifactContent";
import { layoutSurface } from "./lib/hudWindow";
import type {
  Artifact,
  ImageState,
  SurfaceRecord,
  SurfaceStatePayload,
} from "./lib/types";

const params = new URLSearchParams(window.location.search);
const surfaceId = params.get("surface") ?? "";

function parseSize(size?: string): { w: number; h: number } | null {
  if (!size) return null;
  const [w, h] = size.split("x").map((v) => parseInt(v, 10));
  return w > 0 && h > 0 ? { w, h } : null;
}

function desiredSurfaceSize(
  surface: SurfaceRecord,
  artifact: Artifact | null,
  images: Record<string, ImageState>,
): { w: number; h: number } {
  const boost = surface.size === "large" ? 1.22 : 1;
  if (surface.role === "activity") return { w: 620, h: 170 };
  if (surface.role === "compare") return { w: 1080 * boost, h: 640 * boost };
  if (!artifact) return { w: 520, h: 220 };
  switch (artifact.kind) {
    case "image": {
      const ids = artifact.imageIds ?? [];
      if (ids.length === 1) {
        const st = images[ids[0]];
        const dims = parseSize(st?.meta?.size ?? st?.size);
        if (dims) {
          const divisor = surface.size === "large" ? 1 : 2;
          return {
            w: Math.max(380, dims.w / divisor),
            h: Math.max(300, dims.h / divisor),
          };
        }
      }
      return surface.role === "gallery"
        ? { w: 1060 * boost, h: 690 * boost }
        : { w: 900 * boost, h: 620 * boost };
    }
    case "search":
      return { w: 680 * boost, h: 760 * boost };
    case "job":
      return { w: 760 * boost, h: 520 * boost };
    default:
      return { w: 720 * boost, h: 680 * boost };
  }
}

function roleLabel(role: SurfaceRecord["role"]): string {
  switch (role) {
    case "reference":
      return "Referenz";
    case "research":
      return "Recherche";
    case "activity":
      return "Aktivitaet";
    case "gallery":
      return "Bildstudio";
    case "compare":
      return "Vergleich";
    default:
      return "Fokus";
  }
}

function CompareSurface({
  artifacts,
  images,
  onImageAction,
}: {
  artifacts: Artifact[];
  images: Record<string, ImageState>;
  onImageAction: (id: string, action: ImageAction) => void;
}) {
  const pair = artifacts.slice(-2);
  return (
    <div className="surface-compare">
      {pair.map((artifact, index) => (
        <section key={artifact.id} className="compare-pane">
          <span className="compare-label">{index === 0 ? "Vorher" : "Nachher"}</span>
          <ArtifactBody
            artifact={artifact}
            images={images}
            onImageAction={onImageAction}
          />
        </section>
      ))}
    </div>
  );
}

export default function SurfaceApp() {
  const [payload, setPayload] = useState<SurfaceStatePayload | null>(null);
  const payloadRef = useRef<SurfaceStatePayload | null>(null);
  payloadRef.current = payload;
  const requestClose = useCallback(() => {
    void emit("surface-action", { type: "close", surfaceId });
    window.setTimeout(() => {
      void getCurrentWebviewWindow().close().catch(() => undefined);
    }, 80);
  }, []);

  useEffect(() => {
    const unState = listen<SurfaceStatePayload>("surface-state", (e) => {
      if (e.payload.surface.id === surfaceId) setPayload(e.payload);
    });
    void emit("surface-ready", { id: surfaceId });
    return () => {
      unState.then((f) => f());
    };
  }, []);

  const surface = payload?.surface ?? null;
  const artifact = useMemo(() => {
    if (!payload?.surface.artifactId) return null;
    return (
      payload.artifacts.find((a) => a.id === payload.surface.artifactId) ?? null
    );
  }, [payload]);

  const compareArtifacts = useMemo(() => {
    if (!payload?.surface.artifactIds) return [];
    return payload.surface.artifactIds
      .map((id) => payload.artifacts.find((a) => a.id === id))
      .filter(Boolean) as Artifact[];
  }, [payload]);

  const hasMissingArtifacts = useMemo(() => {
    if (!payload || !surface) return false;
    const ids = [
      surface.artifactId,
      ...(surface.artifactIds ?? []),
    ].filter(Boolean) as string[];
    if (ids.length === 0) return false;
    const openIds = new Set(payload.artifacts.map((a) => a.id));
    return ids.some((id) => !openIds.has(id));
  }, [payload, surface]);

  useEffect(() => {
    if (hasMissingArtifacts) requestClose();
  }, [hasMissingArtifacts, requestClose]);

  useEffect(() => {
    if (!surface) return;
    const want = desiredSurfaceSize(surface, artifact, payload?.images ?? {});
    void layoutSurface(
      surface.id,
      want.w,
      want.h,
      surface.placement,
      surface.size,
    );
  }, [surface, artifact?.id, artifact?.updatedAt, payload?.images]);

  const onImageAction = (id: string, action: ImageAction) => {
    void emit("surface-action", { type: "image", surfaceId, id, action });
  };

  if (!surface) {
    return <div className="surface-shell loading" />;
  }

  return (
    <div className={`surface-shell role-${surface.role}`}>
      <div className="surface-bar" data-tauri-drag-region>
        <button
          className="ql-close"
          title="Schliessen"
          aria-label="Surface schliessen"
          onClick={requestClose}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <span className="surface-role" data-tauri-drag-region>
          {roleLabel(surface.role)}
        </span>
        <span className="surface-title" data-tauri-drag-region>
          {surface.title}
        </span>
      </div>
      <div className="surface-content">
        {hasMissingArtifacts ? (
          <div className="surface-empty" />
        ) : surface.role === "compare" ? (
          <CompareSurface
            artifacts={compareArtifacts}
            images={payload?.images ?? {}}
            onImageAction={onImageAction}
          />
        ) : artifact ? (
          <ArtifactBody
            artifact={artifact}
            images={payload?.images ?? {}}
            onImageAction={onImageAction}
          />
        ) : null}
      </div>
    </div>
  );
}
