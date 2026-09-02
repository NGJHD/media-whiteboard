import type { Doc, MediaObject, SceneObject } from '../../shared/doc';

/**
 * Timing and the loop model (CLAUDE.md §8).
 *
 * All loop math is in whole output frames, never seconds. An LCM needs integers,
 * and the output file can only hold a whole number of frames. Quantising each
 * layer to whole output frames *first* guarantees every layer lands on a frame
 * boundary; doing the LCM in seconds yields a fractional count that, once
 * rounded, makes no layer land cleanly.
 */

export const FPS_OPTIONS = [10, 12, 15, 24, 25, 30, 50, 60] as const;

/** §8: the loop is capped at 30 s worth of output frames. */
export const LOOP_CAP_SECONDS = 30;

export function isAnimated(obj: SceneObject): obj is MediaObject {
  return obj.kind === 'media' && obj.frameCount > 1;
}

export function animatedLayers(doc: Doc): MediaObject[] {
  return doc.objects.filter(isAnimated);
}

/**
 * §8.0: a layer's effective rate is set by its *shortest* frame, since that is
 * the fastest thing that must be representable.
 */
export function effectiveFps(layer: MediaObject): number {
  const shortest = Math.min(...layer.frameDurationsMs);
  if (!Number.isFinite(shortest) || shortest <= 0) return 10;
  return 1000 / shortest;
}

/**
 * Rounds up to the next allowed dropdown value, clamped to 10..60.
 *
 * The tolerance matters: source timings are computed from decimal timestamps, so
 * a nominal 25 fps clip can measure 25.000000001 fps. Without it, that rounds up
 * to 30 and inflates both the file size and the loop length for no reason. It is
 * far smaller than the gap between any two adjacent options, so a genuinely
 * faster source still rounds up.
 */
const FPS_EPSILON = 1e-6;

export function ceilToAllowedFps(fps: number): number {
  for (const option of FPS_OPTIONS) {
    if (fps <= option + FPS_EPSILON) return option;
  }
  return 60;
}

/**
 * §8.0: Auto resolves to the highest effective source rate on the canvas.
 * Rounds up, never down — 29.97, 23.976 and 59.94 must become 30, 24 and 60,
 * because rounding down would drop frames. Returns null when nothing animates.
 */
export function autoFps(doc: Doc): number | null {
  const layers = animatedLayers(doc);
  if (layers.length === 0) return null;
  const fastest = Math.max(...layers.map(effectiveFps));
  return Math.min(Math.max(ceilToAllowedFps(fastest), 10), 60);
}

/** The fps actually used. Falls back to 30 when Auto has nothing to detect. */
export function resolveFps(doc: Doc): number {
  if (doc.outputFps !== 'auto') return doc.outputFps;
  return autoFps(doc) ?? 30;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** A layer's native duration in seconds, from its own frame timings. */
export function nativeDurationSec(layer: MediaObject): number {
  return layer.frameDurationsMs.reduce((sum, ms) => sum + ms, 0) / 1000;
}

/** §8.1: the layer's cycle quantised to whole output frames, minimum 1. */
export function cycleFrames(layer: MediaObject, fps: number): number {
  return Math.max(1, Math.round(nativeDurationSec(layer) * fps));
}

export interface LoopPlan {
  fps: number;
  frameCount: number;
  /** True when the LCM exceeded the 30 s cap and layers will cut mid-cycle. */
  capped: boolean;
  /** True when nothing animates: static output, fps irrelevant (§12). */
  isStatic: boolean;
}

/**
 * §8.1. Must be recomputed on every fps change: because the LCM is taken over
 * *rounded* cycle lengths, changing fps does not scale the result
 * proportionally, and can move the document across the cap in either direction.
 */
export function planLoop(doc: Doc): LoopPlan {
  const fps = resolveFps(doc);
  const layers = animatedLayers(doc);

  if (layers.length === 0) {
    return { fps, frameCount: 1, capped: false, isStatic: true };
  }

  const cycles = layers.map((layer) => cycleFrames(layer, fps));
  let frameCount = cycles.reduce((acc, c) => lcm(acc, c), 1);

  const capFrames = LOOP_CAP_SECONDS * fps;
  let capped = false;
  if (frameCount > capFrames) {
    frameCount = Math.max(...cycles);
    capped = true;
  }

  return { fps, frameCount, capped, isStatic: false };
}

/**
 * §8.1 sampling: nearest frame, no blending, no interpolation.
 *
 * Known and accepted limitation: layers with mismatched source rates (24 and 25
 * fps together) judder, because this duplicates a frame roughly once a second.
 */
export function sourceFrameIndex(
  layer: MediaObject,
  outputFrameIndex: number,
  fps: number,
): number {
  if (layer.frameCount <= 1) return 0;

  const cycle = cycleFrames(layer, fps);
  const localFrame = ((outputFrameIndex % cycle) + cycle) % cycle;
  const localTimeMs = (localFrame / fps) * 1000;

  // Find the frame whose [start, end) span contains localTimeMs.
  let elapsed = 0;
  for (let i = 0; i < layer.frameDurationsMs.length; i += 1) {
    const next = elapsed + (layer.frameDurationsMs[i] ?? 0);
    if (localTimeMs < next) return i;
    elapsed = next;
  }
  return layer.frameCount - 1;
}
