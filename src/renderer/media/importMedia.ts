import type { MediaObject } from '../../shared/doc';
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

    const { meta } = result;
    const { canvasRect } = useStore.getState().doc;

    // Scale down to fit the canvas, never up (§7).
    const fit = Math.min(
      canvasRect.width / meta.nativeWidth,
      canvasRect.height / meta.nativeHeight,
      1,
    );
    const width = meta.nativeWidth * fit;
    const height = meta.nativeHeight * fit;

    const object: MediaObject = {
      id: newId(),
      kind: 'media',
      x: at.x + offset,
      y: at.y + offset,
      width,
      height,
      rotation: 0,
      opacity: 1,
      sourcePath: meta.sourcePath,
      cacheKey: meta.cacheKey,
      frameCount: meta.frameCount,
      frameDurationsMs: meta.frameDurationsMs,
      nativeWidth: meta.nativeWidth,
      nativeHeight: meta.nativeHeight,
    };

    // §4: hard clamp into the world rather than allowing an out-of-bounds drop.
    const bounds = objectBounds(object);
    const clamped = clampRectToWorld(bounds);
    object.x += clamped.x - bounds.x;
    object.y += clamped.y - bounds.y;

    // A drop bigger than the whole world cannot be clamped, only shrunk.
    if (object.width > WORLD_MAX - WORLD_MIN || object.height > WORLD_MAX - WORLD_MIN) {
      const shrink = Math.min(
        (WORLD_MAX - WORLD_MIN) / object.width,
        (WORLD_MAX - WORLD_MIN) / object.height,
      );
      object.width *= shrink;
      object.height *= shrink;
    }

    store.apply('Add media', (draft) => {
      draft.objects.push(object);
    });
    useStore.getState().setSelection([object.id]);

    // Decode the first frame so something appears immediately; the preview loop
    // pulls the rest in as it cycles.
    void load(meta.cacheKey, 0).then(() => {
      useStore.getState().setPreviewFrame(useStore.getState().previewFrame);
    });

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
