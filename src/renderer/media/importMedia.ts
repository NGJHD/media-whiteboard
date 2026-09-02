import type { MediaObject } from '../../shared/doc';
import type { MediaMeta } from '../../shared/ipc';
import {
  baseName,
  clampRectToWorld,
  objectBounds,
  previewProxySize,
  WORLD_MAX,
  WORLD_MIN,
} from '../../shared/doc';
import { useStore } from '../state/store';
import { load } from './bitmapCache';

/**
 * Drop handling (CLAUDE.md §7).
 *
 * The object is centred at the cursor and sized to fit within **half** the
 * canvas, never scaled up. Fitting the whole canvas meant every photo-sized drop
 * covered everything already on it, which is the opposite of what a drop onto a
 * composition wants. The canvas is never auto-resized to match dropped media.
 */

function newId(): string {
  return crypto.randomUUID();
}

export interface DropPoint {
  /** World coordinates. */
  x: number;
  y: number;
}

/**
 * Turns decoded metadata into a placed object. Shared by file drops and by
 * clipboard pastes (§11), so both follow the same §7 placement rules.
 *
 * Resolves null when the first frame cannot be decoded, and adds nothing in that
 * case. A static source is copied into the cache rather than transcoded (§7), so
 * the renderer is the first thing to actually look at those bytes — better to
 * find out here, where it is one toast and no layer, than to place an object
 * that silently draws nothing.
 */
export async function importMetaAsObject(
  meta: MediaMeta,
  at: DropPoint,
  offset = 0,
): Promise<MediaObject | null> {
  // The variant the preview will actually ask for (§7), so this proves the
  // thing that is about to be drawn, not a sibling of it.
  const proxy = previewProxySize(meta.nativeWidth, meta.nativeHeight, meta.frameCount) !== null;
  if (!(await load(meta.cacheKey, 0, proxy))) return null;

  const store = useStore.getState();
  const { canvasRect } = store.doc;

  // §7: scale down to fit half the canvas, never up.
  const fit = Math.min(
    canvasRect.width / 2 / meta.nativeWidth,
    canvasRect.height / 2 / meta.nativeHeight,
    1,
  );

  const object: MediaObject = {
    id: newId(),
    kind: 'media',
    x: at.x + offset,
    y: at.y + offset,
    width: meta.nativeWidth * fit,
    height: meta.nativeHeight * fit,
    rotation: 0,
    opacity: 1,
    sourcePath: meta.sourcePath,
    cacheKey: meta.cacheKey,
    frameCount: meta.frameCount,
    frameDurationsMs: meta.frameDurationsMs,
    nativeWidth: meta.nativeWidth,
    nativeHeight: meta.nativeHeight,
  };

  // A drop bigger than the whole world cannot be clamped, only shrunk.
  const worldSize = WORLD_MAX - WORLD_MIN;
  if (object.width > worldSize || object.height > worldSize) {
    const shrink = Math.min(worldSize / object.width, worldSize / object.height);
    object.width *= shrink;
    object.height *= shrink;
  }

  // §4: hard clamp into the world rather than allowing an out-of-bounds drop.
  const bounds = objectBounds(object);
  const clamped = clampRectToWorld(bounds);
  object.x += clamped.x - bounds.x;
  object.y += clamped.y - bounds.y;

  store.apply('Add media', (draft) => {
    draft.objects.push(object);
  });
  useStore.getState().setSelection([object.id]);

  // §7: main resolves as soon as frame one exists, so an animated source lands
  // here mid-decode. Register a job for it and the non-blocking bar under the
  // canvas reports the rest of the frames arriving.
  if (!meta.complete) {
    useStore.getState().beginImport({
      cacheKey: meta.cacheKey,
      name: baseName(meta.sourcePath),
      readyFrames: meta.readyFrames,
      totalFrames: meta.frameCount,
    });
  }

  return object;
}

export async function importFiles(paths: string[], at: DropPoint): Promise<void> {
  const store = useStore.getState();
  const failures: string[] = [];

  // Feedback item 18: a drop always lands you back on Select, so the new object
  // can be moved straight away rather than being drawn over.
  store.setTool('select');

  // Stagger multiple drops so they do not land exactly on top of each other.
  let offset = 0;

  for (const sourcePath of paths) {
    const result = await window.api.importMedia(sourcePath);

    if (!result.ok) {
      failures.push(result.error);
      continue;
    }

    if (!(await importMetaAsObject(result.meta, at, offset))) {
      // The frame is on disk but the renderer could not decode it. Do not leave
      // the background decode running for a layer that was never added.
      window.api.cancelImport(result.meta.cacheKey);
      failures.push(`${baseName(sourcePath)}: could not decode this file.`);
      continue;
    }
    offset += 24;
  }

  // §7/§14: one toast per rejected file, ignored without adding a layer.
  for (const error of failures) {
    useStore.getState().toast('error', error);
  }
}

/** Reads OS paths out of a drop event via the preload bridge. */
export function pathsFromDataTransfer(data: DataTransfer | null): string[] {
  if (!data) return [];
  return Array.from(data.files).map((file) => window.api.pathForFile(file));
}
