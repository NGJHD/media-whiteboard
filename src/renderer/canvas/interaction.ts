import Konva from 'konva';
import type { Doc, LayerId, Rect, SceneObject } from '../../shared/doc';
import { WORLD_MAX, WORLD_MIN, objectBounds } from '../../shared/doc';
import { clampObjectToWorld } from '../actions/objectActions';
import { useStore, type ViewTransform } from '../state/store';
import type { SnapGuide } from './overlay';
import { selectionBounds, snapPoint, snapRect } from './snapping';

/**
 * Select-tool interaction (CLAUDE.md §10, §11).
 *
 * `buildScene` rebuilds the content layer every frame, so its nodes have no
 * stable identity to attach a Transformer to. This layer holds one invisible
 * proxy rectangle per object instead: stable nodes that carry hit testing and
 * the transform handles. They are chrome, not content — they affect no output
 * pixels, so §3's rule about a single construction path is untouched.
 *
 * Single selection gets a Transformer on that object's proxy. A multi-selection
 * gets one on a single group box, which is what makes §10's "uniform scale about
 * the anchor corner, no rotation" straightforward: one scale factor comes out,
 * and it is applied to every member by the formula in §10 rather than letting
 * Konva transform each node independently.
 */

const ROTATION_SNAPS = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180,
  195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345];

/**
 * §10: corners only, never edges.
 *
 * An edge handle can only change one dimension, which means its whole purpose is
 * to distort — and for media that distortion is against the source's own aspect
 * ratio, which is almost never what was wanted. Corners with `keepRatio` hold
 * the ratio by default, and Shift is still there for a deliberate stretch.
 */
const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export interface InteractionHandle {
  layer: Konva.Layer;
  sync(): void;
  guides(): SnapGuide[];
  marquee(): Rect | null;
  /**
   * Stage position of an object's proxy — its centre, since `place` puts the
   * origin there. This is where the transform box and handles actually are, as
   * opposed to where the document says the object is; the two agreeing is what
   * §11's snapping requires and what nothing else can observe.
   */
  proxyPosition(id: LayerId): { x: number; y: number } | null;
  /** Handles currently offered on the selection. Corners only, per §10. */
  enabledAnchors(): string[];
  destroy(): void;
}

interface GestureState {
  id: number;
  /** Object geometry when the gesture started, for group-resize maths. */
  start: Map<LayerId, SceneObject>;
  startBounds: Rect | null;
}

export function createInteraction(stage: Konva.Stage): InteractionHandle {
  const layer = new Konva.Layer();
  stage.add(layer);

  const proxies = new Map<LayerId, Konva.Rect>();
  const groupBox = new Konva.Rect({ name: 'group-box', draggable: true, fill: 'black', opacity: 0 });
  groupBox.visible(false);
  layer.add(groupBox);

  const transformer = new Konva.Transformer({
    // §10: aspect-locked by default, Shift frees it.
    keepRatio: true,
    shiftBehavior: 'inverted',
    rotationSnaps: [],
    borderStroke: '#6ea8fe',
    anchorStroke: '#6ea8fe',
    anchorFill: '#12151a',
    anchorSize: 8,
    ignoreStroke: true,
    padding: 0,
  });
  layer.add(transformer);

  let guides: SnapGuide[] = [];
  let marqueeRect: Rect | null = null;
  let gesture: GestureState | null = null;
  let gestureCounter = 0;
  let shiftHeld = false;
  let ctrlHeld = false;
  let suppressSync = false;

  /* ---------------------------------------------------------------------- */
  /* Modifier tracking                                                      */
  /* ---------------------------------------------------------------------- */

  const onKey = (e: KeyboardEvent) => {
    shiftHeld = e.shiftKey;
    ctrlHeld = e.ctrlKey || e.metaKey;
    // §10: rotation snaps to 15 degrees *while Shift is held*, so the snap list
    // is toggled rather than left on permanently.
    transformer.rotationSnaps(shiftHeld ? ROTATION_SNAPS : []);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  /* ---------------------------------------------------------------------- */
  /* Proxy upkeep                                                           */
  /* ---------------------------------------------------------------------- */

  function view(): ViewTransform {
    return useStore.getState().view;
  }

  /** World rect -> stage coordinates. */
  function place(node: Konva.Rect, obj: SceneObject): void {
    const v = view();
    const width = (obj.kind === 'text' ? obj.boxWidth : obj.width) * v.scale;
    const height = obj.height * v.scale;
    node.setAttrs({
      x: obj.x * v.scale + v.offsetX,
      y: obj.y * v.scale + v.offsetY,
      offsetX: width / 2,
      offsetY: height / 2,
      width,
      height,
      rotation: obj.rotation,
      scaleX: 1,
      scaleY: 1,
    });
  }

  /**
   * Re-places the nodes taking part in the current gesture from the document.
   *
   * A drag is snapped in world space (§11), so the pointer and the snapped
   * result differ by up to the snap threshold. Konva has already moved the node
   * to the raw pointer position, and `sync` is suppressed during a gesture, so
   * without this the object jumps to the guide while the transform handles stay
   * behind under the cursor. Writing the snapped geometry back keeps the box,
   * the handles and the object on the same rectangle.
   */
  function placeSelected(): void {
    const { doc, selection } = useStore.getState();
    for (const id of selection) {
      const node = proxies.get(id);
      const obj = doc.objects.find((o) => o.id === id);
      if (node && obj) place(node, obj);
    }

    if (selection.length > 1) {
      const bounds = selectionBounds(doc, selection);
      if (bounds) {
        const v = view();
        groupBox.position({
          x: bounds.x * v.scale + v.offsetX,
          y: bounds.y * v.scale + v.offsetY,
        });
      }
    }
  }

  function sync(): void {
    if (suppressSync) return;
    const { doc, selection, tool } = useStore.getState();

    // The proxies exist to serve the Select tool; a drawing tool owns the
    // pointer instead, so they must not eat its events.
    layer.listening(tool === 'select');

    const seen = new Set<LayerId>();
    for (const obj of doc.objects) {
      seen.add(obj.id);
      let node = proxies.get(obj.id);
      if (!node) {
        node = new Konva.Rect({ fill: 'black', opacity: 0, draggable: true });
        node.setAttr('layerId', obj.id);
        attachObjectHandlers(node);
        proxies.set(obj.id, node);
        layer.add(node);
      }
      node.draggable(!obj.locked);
      place(node, obj);
    }

    for (const [id, node] of [...proxies]) {
      if (seen.has(id)) continue;
      node.destroy();
      proxies.delete(id);
    }

    groupBox.moveToTop();
    transformer.moveToTop();
    updateTransformer(doc, selection);
  }

  function updateTransformer(doc: Doc, selection: LayerId[]): void {
    // While a text object is being edited in place, its editor is the box on
    // screen (§10). Leaving the transformer up as well puts two rectangles of
    // different sizes on top of each other.
    if (useStore.getState().editingTextId !== null) {
      transformer.nodes([]);
      groupBox.visible(false);
      return;
    }
    if (useStore.getState().tool !== 'select' || selection.length === 0) {
      transformer.nodes([]);
      groupBox.visible(false);
      return;
    }

    if (selection.length === 1) {
      groupBox.visible(false);
      const obj = doc.objects.find((o) => o.id === selection[0]);
      const node = obj ? proxies.get(obj.id) : undefined;
      if (!obj || !node) {
        transformer.nodes([]);
        return;
      }

      transformer.rotateEnabled(true);
      transformer.enabledAnchors(CORNER_ANCHORS);
      // §10: text resize changes boxWidth and reflows, so a corner drag applies
      // only its horizontal component and locking the ratio would be a lie.
      transformer.keepRatio(obj.kind !== 'text');
      transformer.nodes([node]);
      return;
    }

    // §10: multi-select shows a bounding box with corner resize handles only —
    // no rotation handle, no edge handles.
    const bounds = selectionBounds(doc, selection);
    if (!bounds) {
      transformer.nodes([]);
      groupBox.visible(false);
      return;
    }

    const v = view();
    groupBox.setAttrs({
      x: bounds.x * v.scale + v.offsetX,
      y: bounds.y * v.scale + v.offsetY,
      offsetX: 0,
      offsetY: 0,
      width: bounds.width * v.scale,
      height: bounds.height * v.scale,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    });
    groupBox.visible(true);

    transformer.rotateEnabled(false);
    transformer.enabledAnchors(CORNER_ANCHORS);
    // §10: Shift does *not* enable free distortion for a group. A non-uniform
    // scale on a rotated object needs a shear, which the model cannot represent.
    transformer.keepRatio(true);
    transformer.nodes([groupBox]);
  }

  /* ---------------------------------------------------------------------- */
  /* Gestures                                                               */
  /* ---------------------------------------------------------------------- */

  function beginGesture(): void {
    gestureCounter += 1;
    const { doc, selection } = useStore.getState();
    gesture = {
      id: gestureCounter,
      start: new Map(doc.objects.filter((o) => selection.includes(o.id)).map((o) => [o.id, structuredClone(o)])),
      startBounds: selectionBounds(doc, selection),
    };
  }

  function endGesture(): void {
    gesture = null;
    guides = [];
    suppressSync = false;
    sync();
  }

  /** A distinct label per gesture, so two consecutive drags are two undo steps. */
  function label(kind: string): string {
    return `${kind} #${gesture?.id ?? 0}`;
  }

  function attachObjectHandlers(node: Konva.Rect): void {
    node.on('dragstart', () => {
      const id = node.getAttr('layerId') as LayerId;
      const { selection, setSelection } = useStore.getState();
      // Dragging an unselected object selects it first, as every editor does.
      if (!selection.includes(id)) setSelection([id]);
      suppressSync = true;
      beginGesture();
    });

    node.on('dragmove', () => {
      const id = node.getAttr('layerId') as LayerId;
      const v = view();
      const { doc, selection } = useStore.getState();
      const start = gesture?.start.get(id);
      if (!start) return;

      // Where the pointer has taken this proxy, in world coordinates.
      const worldX = (node.x() - v.offsetX) / v.scale;
      const worldY = (node.y() - v.offsetY) / v.scale;
      let dx = worldX - start.x;
      let dy = worldY - start.y;

      // §11: snapping applies to the group bounding box, not to individual
      // members, so a multi-selection moves as one rigid body.
      const base = gesture?.startBounds;
      if (base) {
        const moved: Rect = { ...base, x: base.x + dx, y: base.y + dy };
        const snap = snapRect(moved, doc, selection, v.scale, !ctrlHeld);
        dx += snap.dx;
        dy += snap.dy;
        guides = snap.guides;
      }

      useStore.getState().applyMerged(label('Move'), (draft) => {
        for (const obj of draft.objects) {
          const from = gesture?.start.get(obj.id);
          if (!from) continue;
          obj.x = from.x + dx;
          obj.y = from.y + dy;
          clampObjectToWorld(obj);
        }
      });

      placeSelected();
    });

    node.on('dragend', endGesture);

    node.on('transformstart', () => {
      suppressSync = true;
      beginGesture();
    });

    node.on('transform', () => {
      const id = node.getAttr('layerId') as LayerId;
      const start = gesture?.start.get(id);
      if (!start) return;
      const v = view();

      const scaleX = node.scaleX();
      const scaleY = node.scaleY();
      const worldX = (node.x() - v.offsetX) / v.scale;
      const worldY = (node.y() - v.offsetY) / v.scale;
      const rotation = node.rotation();

      useStore.getState().applyMerged(label('Transform'), (draft) => {
        const obj = draft.objects.find((o) => o.id === id);
        if (!obj) return;

        obj.x = worldX;
        obj.y = worldY;
        obj.rotation = rotation;

        if (obj.kind === 'text') {
          // §10: dragging any handle changes only boxWidth; the text re-wraps and
          // the height follows from the wrapped result. Glyphs never scale here.
          obj.boxWidth = Math.max(16, start.kind === 'text' ? start.boxWidth * scaleX : obj.boxWidth);
          obj.width = obj.boxWidth;
        } else {
          obj.width = Math.max(1, start.width * scaleX);
          obj.height = Math.max(1, start.height * scaleY);
        }
        clampObjectToWorld(obj);
      });

      // Deliberately *not* resetting node.scale here.
      //
      // Konva's Transformer computes each step from the node's live attributes.
      // Resetting the scale to 1 and re-placing the node mid-gesture moves the
      // ground under it: the next pointer event is measured against geometry
      // that has already absorbed the change, so the object lurches between
      // sizes and the drag reads as a move. The node accumulates scale for the
      // whole gesture, the model is derived from `start * scale`, and the reset
      // happens once, on transformend.
    });

    node.on('transformend', () => {
      node.scaleX(1);
      node.scaleY(1);
      endGesture();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Group box gestures                                                     */
  /* ---------------------------------------------------------------------- */

  groupBox.on('dragstart', () => {
    suppressSync = true;
    beginGesture();
  });

  groupBox.on('dragmove', () => {
    const v = view();
    const { doc, selection } = useStore.getState();
    const base = gesture?.startBounds;
    if (!base) return;

    const worldX = (groupBox.x() - v.offsetX) / v.scale;
    const worldY = (groupBox.y() - v.offsetY) / v.scale;
    let dx = worldX - base.x;
    let dy = worldY - base.y;

    const snap = snapRect({ ...base, x: base.x + dx, y: base.y + dy }, doc, selection, v.scale, !ctrlHeld);
    dx += snap.dx;
    dy += snap.dy;
    guides = snap.guides;

    useStore.getState().applyMerged(label('Move'), (draft) => {
      for (const obj of draft.objects) {
        const from = gesture?.start.get(obj.id);
        if (!from) continue;
        obj.x = from.x + dx;
        obj.y = from.y + dy;
        clampObjectToWorld(obj);
      }
    });

    // Snap moved the objects; bring the box and its handles along (§11).
    groupBox.position({
      x: (base.x + dx) * v.scale + v.offsetX,
      y: (base.y + dy) * v.scale + v.offsetY,
    });
    placeSelected();
  });

  groupBox.on('dragend', endGesture);
  groupBox.on('transformstart', () => {
    suppressSync = true;
    beginGesture();
  });

  /**
   * §10 group resize: one uniform scale factor about the anchor corner — the one
   * diagonally opposite the handle being dragged.
   */
  groupBox.on('transform', () => {
    const base = gesture?.startBounds;
    if (!base) return;
    const v = view();

    const scale = groupBox.scaleX();
    if (!Number.isFinite(scale) || scale <= 0) return;

    // The anchor is wherever the box did *not* move: derive it from the new
    // top-left rather than asking the Transformer which handle is active.
    const newX = (groupBox.x() - v.offsetX) / v.scale;
    const newY = (groupBox.y() - v.offsetY) / v.scale;
    const anchorX = Math.abs(newX - base.x) < 1e-6 ? base.x : base.x + base.width;
    const anchorY = Math.abs(newY - base.y) < 1e-6 ? base.y : base.y + base.height;

    useStore.getState().applyMerged(label('Group resize'), (draft) => {
      for (const obj of draft.objects) {
        const from = gesture?.start.get(obj.id);
        if (!from) continue;

        obj.x = anchorX + (from.x - anchorX) * scale;
        obj.y = anchorY + (from.y - anchorY) * scale;
        obj.width = Math.max(1, from.width * scale);
        obj.height = Math.max(1, from.height * scale);
        obj.rotation = from.rotation;

        // §10: an unscaled outline would look wrong after the group grows.
        if (obj.kind === 'shape' && from.kind === 'shape') {
          obj.strokeWidth = from.strokeWidth * scale;
        }
        // §10: glyphs scale *and* boxWidth scales, so the wrap points stay put.
        // This deliberately differs from single-object text resize, which
        // reflows — reflowing here would rearrange text the user only scaled.
        if (obj.kind === 'text' && from.kind === 'text') {
          obj.fontSize = Math.max(1, from.fontSize * scale);
          obj.boxWidth = Math.max(16, from.boxWidth * scale);
          obj.width = obj.boxWidth;
        }
        clampObjectToWorld(obj);
      }
    });

    // As with a single object: the scale stays on the node for the whole
    // gesture and is reset once, at the end.
  });

  groupBox.on('transformend', () => {
    groupBox.scaleX(1);
    groupBox.scaleY(1);
    endGesture();
  });

  /* ---------------------------------------------------------------------- */
  /* World clamping on the handles                                          */
  /* ---------------------------------------------------------------------- */

  interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  }

  /**
   * §11 snapping during a resize.
   *
   * Done here rather than in the `transform` handler for the same reason the
   * drag writes its snapped position back to the node: the handles have to end
   * up on the snapped rectangle too. `boundBoxFunc` is Konva's supported hook
   * for adjusting the box mid-gesture, so the box, the handles and the model all
   * come out of one number — unlike D-021, this is not fighting the Transformer,
   * it is the seam it provides.
   *
   * A resize pins the corner opposite the handle and moves the dragged one, so
   * what gets aligned is that corner. Under `keepRatio` only one axis can be
   * honoured — the other follows from the ratio — so the nearer one wins.
   *
   * Only at rotation 0: the guides are axis-aligned, and a rotated box has no
   * edge that meaningfully lines up with them.
   */
  function snapResize(box: Box): Box {
    const anchor = transformer.getActiveAnchor();
    const v = view();
    if (!anchor || ctrlHeld || v.scale <= 0 || Math.abs(box.rotation) > 1e-6) return box;

    const holdsLeft = anchor.includes('left');
    const holdsRight = anchor.includes('right');
    const holdsTop = anchor.includes('top');
    const holdsBottom = anchor.includes('bottom');
    // Corner handles only (§10), so anything else is the rotater.
    if (!(holdsLeft || holdsRight) || !(holdsTop || holdsBottom)) return box;

    const left = (box.x - v.offsetX) / v.scale;
    const top = (box.y - v.offsetY) / v.scale;
    let width = box.width / v.scale;
    let height = box.height / v.scale;
    if (width <= 0 || height <= 0) return box;

    const movingX = holdsLeft ? left : left + width;
    const movingY = holdsTop ? top : top + height;
    const anchorX = holdsLeft ? left + width : left;
    const anchorY = holdsTop ? top + height : top;

    const { doc, selection } = useStore.getState();
    const snap = snapPoint(movingX, movingY, doc, selection, v.scale, true);

    // Text resizes by width alone (§10); a horizontal guide would point at an
    // edge the model is about to ignore.
    const onlyText =
      selection.length === 1 &&
      doc.objects.find((o) => o.id === selection[0])?.kind === 'text';

    const ratio = width / height;
    const next: SnapGuide[] = [];

    if (transformer.keepRatio()) {
      const takeX =
        snap.distanceX !== null && (snap.distanceY === null || snap.distanceX <= snap.distanceY);
      if (takeX) {
        width = Math.abs(movingX + snap.dx - anchorX);
        height = width / ratio;
        if (snap.guideX) next.push(snap.guideX);
      } else if (snap.distanceY !== null) {
        height = Math.abs(movingY + snap.dy - anchorY);
        width = height * ratio;
        if (snap.guideY) next.push(snap.guideY);
      }
    } else {
      if (snap.distanceX !== null) {
        width = Math.abs(movingX + snap.dx - anchorX);
        if (snap.guideX) next.push(snap.guideX);
      }
      if (!onlyText && snap.distanceY !== null) {
        height = Math.abs(movingY + snap.dy - anchorY);
        if (snap.guideY) next.push(snap.guideY);
      }
    }

    guides = next;
    if (width < 1 || height < 1) return box;

    const newLeft = holdsLeft ? anchorX - width : anchorX;
    const newTop = holdsTop ? anchorY - height : anchorY;
    return {
      x: newLeft * v.scale + v.offsetX,
      y: newTop * v.scale + v.offsetY,
      width: width * v.scale,
      height: height * v.scale,
      rotation: box.rotation,
    };
  }

  // §4: dragging or resizing stops at the world boundary rather than crossing it.
  transformer.boundBoxFunc((oldBox, newBox) => {
    const v = view();
    const box = snapResize(newBox);

    const worldLeft = (box.x - v.offsetX) / v.scale;
    const worldTop = (box.y - v.offsetY) / v.scale;
    const worldRight = worldLeft + box.width / v.scale;
    const worldBottom = worldTop + box.height / v.scale;

    if (
      box.width < 4 ||
      box.height < 4 ||
      worldLeft < WORLD_MIN ||
      worldTop < WORLD_MIN ||
      worldRight > WORLD_MAX ||
      worldBottom > WORLD_MAX
    ) {
      return oldBox;
    }
    return box;
  });

  return {
    layer,
    sync,
    guides: () => guides,
    marquee: () => marqueeRect,
    proxyPosition(id) {
      const node = proxies.get(id);
      return node ? { x: node.x(), y: node.y() } : null;
    },
    enabledAnchors: () => (transformer.nodes().length > 0 ? transformer.enabledAnchors() : []),
    destroy() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      layer.destroy();
    },
  };
}

/** Exposed for the marquee, which the Viewport drives. */
export function objectsIntersecting(doc: Doc, rect: Rect): LayerId[] {
  const out: LayerId[] = [];
  for (const obj of doc.objects) {
    if (obj.locked) continue;
    const b = objectBounds(obj);
    const overlaps =
      b.x < rect.x + rect.width &&
      b.x + b.width > rect.x &&
      b.y < rect.y + rect.height &&
      b.y + b.height > rect.y;
    if (overlaps) out.push(obj.id);
  }
  return out;
}
