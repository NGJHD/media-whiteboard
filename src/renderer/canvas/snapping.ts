import type { Doc, LayerId, Rect } from '../../shared/doc';
import { objectBounds } from '../../shared/doc';
import type { SnapGuide } from './overlay';

/**
 * Drag and resize snapping (CLAUDE.md §11).
 *
 * Threshold is 8 *screen* pixels, converted to world by dividing by viewScale,
 * so snapping feels identical at every zoom level.
 *
 * Targets are other objects' left / centre-x / right and top / centre-y /
 * bottom, plus canvasRect's edges and centre.
 */

const THRESHOLD_SCREEN_PX = 8;

interface Candidate {
  position: number;
  /** Which edge of the moving rect this candidate would align. */
  edge: 'start' | 'centre' | 'end';
}

function verticalTargets(doc: Doc, exclude: LayerId[]): number[] {
  const out: number[] = [];
  const { canvasRect } = doc;
  out.push(canvasRect.x, canvasRect.x + canvasRect.width / 2, canvasRect.x + canvasRect.width);
  for (const obj of doc.objects) {
    if (exclude.includes(obj.id)) continue;
    const b = objectBounds(obj);
    out.push(b.x, b.x + b.width / 2, b.x + b.width);
  }
  return out;
}

function horizontalTargets(doc: Doc, exclude: LayerId[]): number[] {
  const out: number[] = [];
  const { canvasRect } = doc;
  out.push(canvasRect.y, canvasRect.y + canvasRect.height / 2, canvasRect.y + canvasRect.height);
  for (const obj of doc.objects) {
    if (exclude.includes(obj.id)) continue;
    const b = objectBounds(obj);
    out.push(b.y, b.y + b.height / 2, b.y + b.height);
  }
  return out;
}

function best(
  moving: Candidate[],
  targets: number[],
  threshold: number,
): { delta: number; guide: number } | null {
  let bestDistance = threshold;
  let result: { delta: number; guide: number } | null = null;

  for (const candidate of moving) {
    for (const target of targets) {
      const distance = Math.abs(candidate.position - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        result = { delta: target - candidate.position, guide: target };
      }
    }
  }
  return result;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/**
 * Snaps a moving bounding box. `exclude` is the ids being moved, so an object
 * never snaps to itself.
 *
 * Hold Ctrl to disable — the caller passes `enabled: false` (§11).
 */
export function snapRect(
  rect: Rect,
  doc: Doc,
  exclude: LayerId[],
  viewScale: number,
  enabled: boolean,
): SnapResult {
  if (!enabled || viewScale <= 0) return { dx: 0, dy: 0, guides: [] };

  const threshold = THRESHOLD_SCREEN_PX / viewScale;
  const guides: SnapGuide[] = [];

  const vertical = best(
    [
      { position: rect.x, edge: 'start' },
      { position: rect.x + rect.width / 2, edge: 'centre' },
      { position: rect.x + rect.width, edge: 'end' },
    ],
    verticalTargets(doc, exclude),
    threshold,
  );

  const horizontal = best(
    [
      { position: rect.y, edge: 'start' },
      { position: rect.y + rect.height / 2, edge: 'centre' },
      { position: rect.y + rect.height, edge: 'end' },
    ],
    horizontalTargets(doc, exclude),
    threshold,
  );

  if (vertical) guides.push({ orientation: 'v', position: vertical.guide });
  if (horizontal) guides.push({ orientation: 'h', position: horizontal.guide });

  return { dx: vertical?.delta ?? 0, dy: horizontal?.delta ?? 0, guides };
}

/** Union of several objects' bounds — the group box that snapping applies to. */
export function selectionBounds(doc: Doc, ids: LayerId[]): Rect | null {
  let rect: Rect | null = null;
  for (const obj of doc.objects) {
    if (!ids.includes(obj.id)) continue;
    const b = objectBounds(obj);
    if (!rect) {
      rect = { ...b };
      continue;
    }
    const right = Math.max(rect.x + rect.width, b.x + b.width);
    const bottom = Math.max(rect.y + rect.height, b.y + b.height);
    rect.x = Math.min(rect.x, b.x);
    rect.y = Math.min(rect.y, b.y);
    rect.width = right - rect.x;
    rect.height = bottom - rect.y;
  }
  return rect;
}
