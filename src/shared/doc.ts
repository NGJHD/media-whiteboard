/**
 * The document model (CLAUDE.md §5).
 *
 * Everything lives in one world coordinate space in pixels. `canvasRect` is a
 * rectangle in that space — the region that gets exported — and objects never
 * move when it changes (§4).
 */

export type LayerId = string;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BaseObject {
  id: LayerId;
  /** World coordinates of the object's centre. */
  x: number;
  y: number;
  /** World size, before rotation. */
  width: number;
  height: number;
  /** Degrees. */
  rotation: number;
  /** 0..1 */
  opacity: number;
  locked?: boolean;
}

export interface MediaObject extends BaseObject {
  kind: 'media';
  sourcePath: string;
  /** §7: sha256(sourcePath + mtimeMs + fileSize), first 16 hex chars. */
  cacheKey: string;
  /** 1 for static images. */
  frameCount: number;
  /** Native timing; length === frameCount. */
  frameDurationsMs: number[];
  nativeWidth: number;
  nativeHeight: number;
}

export interface ShapeObject extends BaseObject {
  kind: 'shape';
  shape: 'rect' | 'ellipse';
  stroke: string;
  strokeWidth: number;
  /** null means no fill. */
  fill: string | null;
}

export interface TextObject extends BaseObject {
  kind: 'text';
  /** May contain newlines. */
  text: string;
  fontFamily: string;
  fontSize: number;
  fontStyle: string;
  color: string;
  outline: { color: string; width: number } | null;
  shadow: { color: string; blur: number; offsetX: number; offsetY: number } | null;
  /** Text reflows within this; height is auto-computed (§10). */
  boxWidth: number;
}

export type SceneObject = MediaObject | ShapeObject | TextObject;

/** §6: brush and eraser strokes are raster commands, not objects. */
export interface StrokeCommand {
  tool: 'brush' | 'eraser';
  /** Flat [x0, y0, x1, y1, …] in world coordinates. */
  points: number[];
  color: string;
  size: number;
  timestamp: number;
}

export interface PaintLayer {
  strokes: StrokeCommand[];
  /** Union of every stroke's bounds, inflated by stroke width. Null when empty. */
  dirtyRect: Rect | null;
}

export type OutputFps = number | 'auto';

export interface Doc {
  canvasRect: Rect;
  background: { transparent: boolean; color: string };
  outputFps: OutputFps;
  quality: 'low' | 'medium' | 'high';
  format: 'webp' | 'gif';
  outputPath: string;
  /** Array order is z-order; index 0 is the back. */
  objects: SceneObject[];
  paint: PaintLayer;
}

/* -------------------------------------------------------------------------- */
/* Limits (§4, §6)                                                            */
/* -------------------------------------------------------------------------- */

/** §4: canvasRect width and height are each capped at this. */
export const MAX_CANVAS_DIMENSION = 2560;

/** §6: the paint buffer is fixed at 4096 x 4096 world pixels, centred on origin. */
export const PAINT_BUFFER_SIZE = 4096;

/**
 * §4: the usable world is the paint buffer's extent. canvasRect and every
 * object's bounding box are hard clamped to it, or paint would silently stop
 * existing past the buffer edge.
 */
export const WORLD_MIN = -PAINT_BUFFER_SIZE / 2;
export const WORLD_MAX = PAINT_BUFFER_SIZE / 2;

/** §7: sources longer than this are rejected on drop. */
export const MAX_SOURCE_SECONDS = 30;

/** §9 defaults, centred on the world origin so the world clamp is symmetric. */
export function createEmptyDoc(outputPath: string): Doc {
  return {
    canvasRect: { x: -640, y: -360, width: 1280, height: 720 },
    background: { transparent: false, color: '#000000' },
    outputFps: 'auto',
    quality: 'high',
    format: 'webp',
    outputPath,
    objects: [],
    paint: { strokes: [], dirtyRect: null },
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Axis-aligned bounds of an object, accounting for rotation about its centre. */
export function objectBounds(obj: SceneObject): Rect {
  const rad = (obj.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const width = obj.width * cos + obj.height * sin;
  const height = obj.width * sin + obj.height * cos;
  return { x: obj.x - width / 2, y: obj.y - height / 2, width, height };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function rectWithin(rect: Rect, min = WORLD_MIN, max = WORLD_MAX): boolean {
  return (
    rect.x >= min && rect.y >= min && rect.x + rect.width <= max && rect.y + rect.height <= max
  );
}

/** Clamps a rect's position (never its size) so it sits inside the world. */
export function clampRectToWorld(rect: Rect): Rect {
  const x = Math.min(Math.max(rect.x, WORLD_MIN), WORLD_MAX - rect.width);
  const y = Math.min(Math.max(rect.y, WORLD_MIN), WORLD_MAX - rect.height);
  return { ...rect, x, y };
}
