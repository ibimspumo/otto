import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { hideDrops, showDrops } from "../lib/hudWindow";
import * as api from "../lib/tauriApi";
import type { Artifact, ImageFolder, ImageState, Settings } from "../lib/types";
import type { ImageAction } from "../components/ArtifactContent";

interface UsePanelSyncArgs {
  panelOpen: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  pendingPresent: MutableRefObject<{
    mode: "gross" | "riesig" | "klein";
    id?: string;
  } | null>;
  artifacts: Artifact[];
  activeArtifactId: string | null;
  images: Record<string, ImageState>;
  imageFolders: ImageFolder[];
  artifactsRef: MutableRefObject<Artifact[]>;
  activeArtifactIdRef: MutableRefObject<string | null>;
  imagesRef: MutableRefObject<Record<string, ImageState>>;
  imageFoldersRef: MutableRefObject<ImageFolder[]>;
  setActiveArtifactId: Dispatch<SetStateAction<string | null>>;
  setSettings: Dispatch<SetStateAction<Settings | null>>;
  closeArtifact: (id: string) => boolean;
  presentArtifact: (mode: "gross" | "riesig" | "klein", id?: string) => void;
  handleImageAction: (id: string, action: ImageAction) => Promise<void>;
  handleOpenImage: (id: string) => void;
  handleGalleryFolder: (folderId: string | null) => void;
}

/** Nur die Bilder, die von Artefakten referenziert werden (Payload-Diät). */
function visibleImages(
  artifacts: Artifact[],
  images: Record<string, ImageState>,
): Record<string, ImageState> {
  const used: Record<string, ImageState> = {};
  for (const a of artifacts) {
    for (const id of a.imageIds ?? []) {
      if (images[id]) used[id] = images[id];
    }
    if (a.kind === "markdown" && a.content.includes("otto-image:")) {
      for (const [id, st] of Object.entries(images)) {
        if (a.content.includes(`otto-image:${id}`)) used[id] = st;
      }
    }
  }
  return used;
}

export function usePanelSync({
  panelOpen,
  setPanelOpen,
  pendingPresent,
  artifacts,
  activeArtifactId,
  images,
  imageFolders,
  artifactsRef,
  activeArtifactIdRef,
  imagesRef,
  imageFoldersRef,
  setActiveArtifactId,
  setSettings,
  closeArtifact,
  presentArtifact,
  handleImageAction,
  handleOpenImage,
  handleGalleryFolder,
}: UsePanelSyncArgs) {
  const panelWasOpen = useRef(false);

  useEffect(() => {
    if (panelOpen) {
      void showDrops();
      void emit("panel-open", { fresh: !panelWasOpen.current });
      if (pendingPresent.current) {
        void emit("panel-present", pendingPresent.current);
        pendingPresent.current = null;
      }
    } else {
      void hideDrops();
    }
    panelWasOpen.current = panelOpen;
  }, [panelOpen, pendingPresent]);

  useEffect(() => {
    // Nur referenzierte Bilder spiegeln — sonst wächst jedes panel-state-
    // Event während der Generierung (data:-URLs!) auf Megabyte-Größe.
    void emit("panel-state", {
      artifacts,
      activeId: activeArtifactId,
      images: visibleImages(artifacts, images),
      imageFolders,
    });
  }, [artifacts, activeArtifactId, images, imageFolders]);

  useEffect(() => {
    const unReady = listen("panel-ready", () => {
      void emit("panel-state", {
        artifacts: artifactsRef.current,
        activeId: activeArtifactIdRef.current,
        images: visibleImages(artifactsRef.current, imagesRef.current),
        imageFolders: imageFoldersRef.current,
      });
    });
    const unClose = listen("panel-close", () => setPanelOpen(false));
    const unAction = listen<{
      type: "select" | "present" | "close" | "image" | "open-image" | "gallery-folder";
      id?: string;
      action?: "favorite" | "delete" | "save";
      folderId?: string | null;
    }>("panel-action", (e) => {
      const p = e.payload;
      if (p.type === "select" && p.id) {
        setActiveArtifactId(p.id);
      } else if (p.type === "present" && p.id) {
        setActiveArtifactId(p.id);
        presentArtifact("gross", p.id);
      } else if (p.type === "close" && p.id) {
        closeArtifact(p.id);
      } else if (p.type === "image" && p.id && p.action) {
        void handleImageAction(p.id, p.action);
      } else if (p.type === "open-image" && p.id) {
        handleOpenImage(p.id);
      } else if (p.type === "gallery-folder") {
        handleGalleryFolder(p.folderId ?? null);
      }
    });
    const unSettings = listen("settings-changed", () => {
      api
        .getSettings()
        .then(setSettings)
        .catch((e) => void api.logLine(`settings refresh failed: ${String(e)}`));
    });
    return () => {
      unReady.then((f) => f());
      unClose.then((f) => f());
      unAction.then((f) => f());
      unSettings.then((f) => f());
    };
  }, [
    artifactsRef,
    activeArtifactIdRef,
    imagesRef,
    imageFoldersRef,
    setPanelOpen,
    setActiveArtifactId,
    setSettings,
    closeArtifact,
    presentArtifact,
    handleImageAction,
    handleOpenImage,
    handleGalleryFolder,
  ]);

  return useCallback(() => {
    setPanelOpen((open) => !open);
  }, [setPanelOpen]);
}
