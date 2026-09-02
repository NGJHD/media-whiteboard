import { frameUrl } from '../../shared/ipc';

/**
 * In-memory decoded-frame cache (CLAUDE.md §7).
 *
 * Budgeted in bytes, not frame count, because a 2560x1440 frame costs 45x what a
 * 320x180 one does — a count-based cap would either thrash on large media or
 * blow the budget on small.
 *
 * Eviction is least-recently-drawn, so the frames the preview loop is currently
 * cycling through stay resident.
 *
 * Frames come in two variants and they are cached separately: the **native**
 * frames export reads, and the reduced-resolution **proxies** the preview draws
 * (§7). Nothing mixes them — a caller asks for one or the other.
 */

const BUDGET_BYTES = 512 * 1024 * 1024;

interface Entry {
  bitmap: ImageBitmap;
  bytes: number;
  /** `<cacheKey>:<variant>` — what `lastDrawn` is keyed by, so eviction can spare it. */
  layer: string;
}

/** Map iteration order is insertion order, which makes it usable as an LRU. */
const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<ImageBitmap | null>>();
let totalBytes = 0;

function layerKey(cacheKey: string, proxy: boolean): string {
  return `${cacheKey}:${proxy ? 'p' : 'f'}`;
}

function keyFor(cacheKey: string, index: number, proxy: boolean): string {
  return `${layerKey(cacheKey, proxy)}:${index}`;
}

/**
 * The most recent frame each layer actually drew.
 *
 * A media node with no bitmap draws nothing at all, which is why a freshly
 * dropped file showed only its selection handles, and why a layer blinks out if
 * the preview outruns the decoder. Holding the last frame is strictly better
 * than a hole: while a background decode is still running (§7) that is frame 0,
 * and mid-playback it is the frame before this one.
 *
 * Export never reaches this path — §12 prefetches every frame it needs before
 * the synchronous `stage.draw()` — so output pixels are unaffected.
 */
const lastDrawn = new Map<string, ImageBitmap>();

/**
 * A closed `ImageBitmap` reports zero dimensions, and drawing one throws
 * `InvalidStateError` from inside Konva's layer draw — which leaves the layer's
 * `_waitingForDraw` latched and the canvas frozen for good.
 *
 * Eviction is prevented from closing anything reachable above, so this should
 * never fire. It is here because the consequence of being wrong is not a wrong
 * pixel, it is a dead canvas.
 */
function alive(bitmap: ImageBitmap): boolean {
  return bitmap.width > 0 && bitmap.height > 0;
}

function evictTo(limit: number): void {
  for (const [key, entry] of entries) {
    if (totalBytes <= limit) return;
    // Never close the frame a layer is currently standing on. `peekOrLast`
    // hands that bitmap out whenever the exact frame is not resident, and
    // closing it turns the next draw into a detached-source error.
    if (lastDrawn.get(entry.layer) === entry.bitmap) continue;
    entry.bitmap.close();
    entries.delete(key);
    totalBytes -= entry.bytes;
  }
}

/** Marks an entry as most recently used by reinserting it at the tail. */
function touch(key: string, entry: Entry): void {
  entries.delete(key);
  entries.set(key, entry);
}

/** Synchronous lookup. Returns null if the frame is not decoded yet. */
export function peek(cacheKey: string, index: number, proxy = false): ImageBitmap | null {
  const key = keyFor(cacheKey, index, proxy);
  const entry = entries.get(key);
  if (!entry || !alive(entry.bitmap)) return null;
  touch(key, entry);
  lastDrawn.set(entry.layer, entry.bitmap);
  return entry.bitmap;
}

export function peekOrLast(cacheKey: string, index: number, proxy = false): ImageBitmap | null {
  const exact = peek(cacheKey, index, proxy);
  if (exact) return exact;

  const layer = layerKey(cacheKey, proxy);
  const last = lastDrawn.get(layer);
  if (last && alive(last)) return last;
  lastDrawn.delete(layer);
  return null;
}

export async function load(
  cacheKey: string,
  index: number,
  proxy = false,
): Promise<ImageBitmap | null> {
  const key = keyFor(cacheKey, index, proxy);

  const existing = entries.get(key);
  if (existing) {
    touch(key, existing);
    return existing.bitmap;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const response = await fetch(frameUrl(cacheKey, index, proxy));
      if (!response.ok) return null;
      const bitmap = await createImageBitmap(await response.blob());

      const bytes = bitmap.width * bitmap.height * 4;
      entries.set(key, { bitmap, bytes, layer: layerKey(cacheKey, proxy) });
      totalBytes += bytes;
      evictTo(BUDGET_BYTES);
      return bitmap;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Decodes a run of frames ahead of time. Export needs its bitmap resident before
 * the synchronous `stage.draw()`, or Konva silently renders a blank node (§3).
 */
export async function prefetch(cacheKey: string, indices: number[], proxy = false): Promise<void> {
  await Promise.all(indices.map((i) => load(cacheKey, i, proxy)));
}

export function evictEntry(cacheKey: string): void {
  for (const proxy of [false, true]) lastDrawn.delete(layerKey(cacheKey, proxy));
  for (const [key, entry] of [...entries]) {
    if (!key.startsWith(`${cacheKey}:`)) continue;
    entry.bitmap.close();
    entries.delete(key);
    totalBytes -= entry.bytes;
  }
}

export function stats(): { bytes: number; frames: number; budget: number } {
  return { bytes: totalBytes, frames: entries.size, budget: BUDGET_BYTES };
}

export function clear(): void {
  for (const entry of entries.values()) entry.bitmap.close();
  entries.clear();
  lastDrawn.clear();
  totalBytes = 0;
}
