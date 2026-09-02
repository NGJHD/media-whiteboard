import Konva from 'konva';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Rect } from '../../shared/doc';
import { buildScene, framesNeededAt } from '../scene/buildScene';
import { planLoop } from '../scene/timing';
import { load, peek } from '../media/bitmapCache';
import { importFiles, pathsFromDataTransfer } from '../media/importMedia';
import { cycleAt, objectsAt } from '../actions/objectActions';
import { screenToWorld, useStore } from '../state/store';
import { drawOverlay } from './overlay';
import { createInteraction, objectsIntersecting, type InteractionHandle } from './interaction';
import { beginShape, beginStroke, placeText, type DrawGesture } from './drawTools';
import { ContextMenu, type MenuState } from '../ui/ContextMenu';
import { ImportProgress } from '../ui/ImportProgress';
import { TextEditor } from '../ui/TextEditor';

/** How far ahead to decode. Roughly half a second at typical output rates. */
const PREFETCH_FRAMES = 12;

/**
 * The canvas viewport (CLAUDE.md §3, §9, §10, §11).
 *
 * Three Konva layers, bottom to top: content, built only by `buildScene`; an
 * overlay for chrome that must never reach the output; and the interaction layer
 * holding proxy nodes and the Transformer.
 *
 * One shared requestAnimationFrame loop advances a global output frame index and
 * redraws once (§11). Never one timer per layer.
 *
 * The canvas is **always** fitted to the window (§4). There is no zoom and no
 * pan, so the loop below refits whenever canvasRect or the viewport size has
 * moved, wherever that change came from.
 */
export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const contentRef = useRef<Konva.Layer | null>(null);
  const overlayRef = useRef<Konva.Layer | null>(null);
  const interactionRef = useRef<InteractionHandle | null>(null);
  const marqueeRef = useRef<{ origin: { x: number; y: number }; rect: Rect; additive: boolean } | null>(null);
  const drawRef = useRef<DrawGesture | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const stage = new Konva.Stage({ container, width: 1, height: 1 });
    const content = new Konva.Layer({ listening: false });
    const overlay = new Konva.Layer({ listening: false });
    stage.add(content);
    stage.add(overlay);
    const interaction = createInteraction(stage);

    stageRef.current = stage;
    contentRef.current = content;
    overlayRef.current = overlay;
    interactionRef.current = interaction;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      stage.size({ width: rect.width, height: rect.height });
      useStore.getState().setViewport({ width: rect.width, height: rect.height });
    };
    resize();
    useStore.getState().fitToWindow();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // Dev-only, like the hooks in main.tsx: where the transform handles ended up
    // is not in the store, so a test that drives real pointer events has no
    // other way to see it. Vite strips this from production builds.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__mwProxyRect = (id: string) =>
        interaction.proxyPosition(id);
    }

    /* ---- selection on empty space and marquee (§10, §11) ---------------- */

    stage.on('mousedown touchstart', (e) => {
      setMenu(null);
      const state = useStore.getState();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const mouse = e.evt as MouseEvent;

      // A drawing tool owns the pointer entirely (§10).
      if (state.tool !== 'select') {
        if (mouse.button !== 0) return;
        const world = screenToWorld(state.view, pointer.x, pointer.y);

        switch (state.tool) {
          case 'brush':
          case 'eraser':
            drawRef.current = beginStroke(world, state.tool);
            return;
          case 'rect':
          case 'ellipse':
            drawRef.current = beginShape(world, state.tool);
            return;
          case 'text':
            // The default action of this mousedown is to focus the canvas, and
            // it would land *after* the editor below has taken focus — blurring
            // it, committing an empty string, and deleting the object before it
            // was ever visible. Preventing it is what makes the Text tool work.
            e.evt.preventDefault();
            placeText(world);
            return;
          default:
            return;
        }
      }

      if (mouse.button !== 0) return;

      const world = screenToWorld(state.view, pointer.x, pointer.y);

      // §10: Alt+click cycles through overlapping objects — the only way to
      // reach one that is fully covered.
      if (mouse.altKey) {
        const next = cycleAt(state.doc, world.x, world.y, state.selection);
        state.setSelection(next ? [next] : []);
        e.cancelBubble = true;
        return;
      }

      const hit = objectsAt(state.doc, world.x, world.y)[0];
      if (hit) {
        if (mouse.shiftKey) {
          state.toggleSelection(hit.id);
          e.cancelBubble = true;
        } else if (!state.selection.includes(hit.id)) {
          state.setSelection([hit.id]);
        }
        return;
      }

      // Empty space: rubber-band, and deselect unless adding.
      if (!mouse.shiftKey) state.setSelection([]);
      marqueeRef.current = {
        origin: world,
        rect: { x: world.x, y: world.y, width: 0, height: 0 },
        additive: mouse.shiftKey,
      };
    });

    stage.on('mousemove touchmove', (e) => {
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const state = useStore.getState();

      if (drawRef.current) {
        const mouse = e.evt as MouseEvent;
        drawRef.current.move(screenToWorld(state.view, pointer.x, pointer.y), {
          alt: mouse.altKey,
          shift: mouse.shiftKey,
        });
        return;
      }

      const marquee = marqueeRef.current;
      if (!marquee) return;
      const world = screenToWorld(state.view, pointer.x, pointer.y);
      marquee.rect = {
        x: Math.min(marquee.origin.x, world.x),
        y: Math.min(marquee.origin.y, world.y),
        width: Math.abs(world.x - marquee.origin.x),
        height: Math.abs(world.y - marquee.origin.y),
      };
    });

    const finishPointer = (e?: { evt: Event }) => {
      if (drawRef.current) {
        const pointer = stage.getPointerPosition();
        const state = useStore.getState();
        const mouse = e?.evt as MouseEvent | undefined;
        if (pointer) {
          drawRef.current.end(screenToWorld(state.view, pointer.x, pointer.y), {
            alt: mouse?.altKey ?? false,
            shift: mouse?.shiftKey ?? false,
          });
        } else {
          drawRef.current.cancel();
        }
        drawRef.current = null;
        return;
      }

      const marquee = marqueeRef.current;
      marqueeRef.current = null;
      if (!marquee) return;
      // A click, not a drag: nothing to band-select.
      if (marquee.rect.width < 2 && marquee.rect.height < 2) return;

      const state = useStore.getState();
      const hits = objectsIntersecting(state.doc, marquee.rect);
      state.setSelection(marquee.additive ? [...new Set([...state.selection, ...hits])] : hits);
    };

    stage.on('mouseup touchend', finishPointer);
    stage.on('mouseleave', finishPointer);

    // Double-click opens a text object for editing, which is how every editor
    // behaves and is more discoverable than remembering the Text tool.
    stage.on('dblclick dbltap', (e) => {
      const state = useStore.getState();
      if (state.tool !== 'select') return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const world = screenToWorld(state.view, pointer.x, pointer.y);
      const hit = objectsAt(state.doc, world.x, world.y)[0];
      if (hit?.kind !== 'text') return;

      e.evt.preventDefault();
      e.cancelBubble = true;
      state.setSelection([hit.id]);
      state.setEditingText(hit.id);
    });

    /* ---- context menu (§11) --------------------------------------------- */

    stage.on('contextmenu', (e) => {
      e.evt.preventDefault();
      const state = useStore.getState();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const world = screenToWorld(state.view, pointer.x, pointer.y);
      const hit = objectsAt(state.doc, world.x, world.y)[0];

      if (hit) {
        // Right-clicking outside the current selection retargets it, as every
        // editor does; right-clicking inside a multi-selection keeps it.
        if (!state.selection.includes(hit.id)) state.setSelection([hit.id]);
      } else {
        // §11: empty canvas gets the canvas menu. A right-click never reaches
        // the mousedown handler that would otherwise have deselected, so it has
        // to do it here — otherwise the menu belongs to an object nowhere near
        // the cursor.
        state.setSelection([]);
      }

      setMenu({ x: pointer.x, y: pointer.y, world, onObject: Boolean(hit) });
    });

    return () => {
      observer.disconnect();
      interaction.destroy();
      stage.destroy();
      stageRef.current = null;
    };
  }, []);

  // The single shared animation loop (§11): one rAF, one frame index, one draw.
  useEffect(() => {
    let raf = 0;
    let lastFrame = -1;
    let lastRevision = -1;
    let lastFit = '';
    // Whether the previous draw was made with frames still undecoded. Without
    // this the run ends one draw too early: the bitmap lands *after* the last
    // "still missing" pass, and the tick that would have shown it sees nothing
    // changed and returns. That is why a dropped image only appeared once it
    // was nudged.
    let drewIncomplete = false;
    const startedAt = performance.now();

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const state = useStore.getState();
      const stage = stageRef.current;
      const content = contentRef.current;
      const overlay = overlayRef.current;
      const interaction = interactionRef.current;
      if (!stage || !content || !overlay || !interaction) return;

      // §4: the canvas is always fitted. Every route to a new canvasRect or a
      // new viewport size funnels through here, so no caller has to remember.
      const { canvasRect } = state.doc;
      const fit = [
        canvasRect.x, canvasRect.y, canvasRect.width, canvasRect.height,
        state.viewport.width, state.viewport.height,
      ].join(',');
      if (fit !== lastFit) {
        lastFit = fit;
        state.fitToWindow();
        return;
      }

      const plan = planLoop(state.doc);

      // Drive the frame index from wall-clock time rather than incrementing once
      // per rAF: a 120 Hz display must not play a 25 fps loop at five times speed.
      const frame = plan.isStatic
        ? 0
        : Math.floor(((performance.now() - startedAt) / 1000) * plan.fps) % plan.frameCount;

      // buildScene only peeks the bitmap cache: it draws nothing for a frame that
      // is not decoded yet, because it has to stay synchronous for export. The
      // preview is what asks for those frames, and it keeps redrawing while any
      // are outstanding so they appear as soon as they land.
      let missing = false;
      for (const need of framesNeededAt(state.doc, frame)) {
        if (peek(need.cacheKey, need.index)) continue;
        missing = true;
        void load(need.cacheKey, need.index);
      }

      if (!plan.isStatic) {
        for (let ahead = 1; ahead <= PREFETCH_FRAMES; ahead += 1) {
          const future = (frame + ahead) % plan.frameCount;
          for (const need of framesNeededAt(state.doc, future)) {
            if (!peek(need.cacheKey, need.index)) void load(need.cacheKey, need.index);
          }
        }
      }

      const marquee = marqueeRef.current?.rect ?? null;
      const guides = interaction.guides();
      const interacting = marquee !== null || guides.length > 0 || drawRef.current !== null;

      // Nothing to redraw if neither the frame nor the document has moved. A
      // static document therefore costs one scene build, not sixty a second.
      const stale = missing || drewIncomplete;
      if (!stale && !interacting && frame === lastFrame && state.revision === lastRevision) return;
      lastFrame = frame;
      lastRevision = state.revision;
      drewIncomplete = missing;

      if (frame !== state.previewFrame) state.setPreviewFrame(frame);

      const { view } = state;
      content.destroyChildren();
      const group = buildScene(state.doc, frame, {
        clipToCanvas: false,
        // The in-place editor sits exactly over this node (§10); drawing both
        // would double up the glyphs. Export never sets this — the UI is
        // blocked during export, so nothing can be mid-edit.
        hiddenIds: state.editingTextId ? [state.editingTextId] : [],
      });
      group.scale({ x: view.scale, y: view.scale });
      group.position({ x: view.offsetX, y: view.offsetY });
      content.add(group);

      drawOverlay(overlay, { ...state, snapGuides: guides, marquee });
      interaction.sync();

      // `draw`, not `batchDraw`. This function *is* the animation frame, so
      // deferring to another one buys no coalescing and costs a frame of
      // latency — but more importantly it opens a window. `batchDraw` runs the
      // real draw from a later callback, and between building these nodes and
      // Konva reading their bitmaps, an in-flight decode can land and evict one.
      // Drawing here keeps peek-and-draw in a single synchronous block, so
      // nothing can be freed out from under a node that is about to be drawn.
      content.draw();
      overlay.draw();
      interaction.layer.draw();
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={containerRef}
      className="viewport"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const paths = pathsFromDataTransfer(e.dataTransfer);
        if (paths.length === 0) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const { view } = useStore.getState();
        // §7: centred at the cursor, in world coordinates.
        const at = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
        void importFiles(paths, at);
      }}
    >
      <TextEditor />
      <ImportProgress />
      {menu ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
