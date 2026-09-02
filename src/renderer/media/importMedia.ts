import type { MediaObject } from '../../shared/doc';
import type { MediaMeta } from '../../shared/ipc';
import { clampRectToWorld, objectBounds, WORLD_MAX, WORLD_MIN } from '../../shared/doc';
import { useStore } from '../state/store';
import { load } from './bitmapCache';

/**
 * Drop handling (CLAUDE.md §7).
 *
 * The object is centred at the cursor at native size. If native size exceeds
 * canvasRect in either dimension it scales down proportionally, and it never
 * scales up. The canvas is never auto-resized to match dropped media.
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
 */
export function importMetaAsObject(meta: MediaMeta, at: DropPoint, offset = 0): MediaObject {
  const store = useStore.getState();
  const { canvasRect } = store.doc;

  // Scale down to fit the canvas, never up (§7).
  const fit = Math.min(canvasRect.width / meta.nativeWidth, canvasRect.height / meta.nativeHeight, 1);

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

  // Decode the first frame so something appears immediately; the preview loop
  // pulls the rest in as it cycles.
  void load(meta.cacheKey, 0);

  return object;
}

export async function importFiles(paths: string[], at: DropPoint): Promise<void> {
  const store = useStore.getState();
  const failures: string[] = [];

  // Stagger multiple drops so they do not land exactly on top of each other.
  let offset = 0;

  for (const sourcePath of paths) {
    const result = await window.api.importMedia(sourcePath);

    if (!result.ok) {
      failures.push(result.error);
      continue;
    }

    importMetaAsObject(result.meta, at, offset);
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
