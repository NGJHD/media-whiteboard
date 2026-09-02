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
import { ContextMenu, type MenuState } from '../ui/ContextMenu';

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
 */
export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const contentRef = useRef<Konva.Layer | null>(null);
  const overlayRef = useRef<Konva.Layer | null>(null);
  const interactionRef = useRef<InteractionHandle | null>(null);
  const marqueeRef = useRef<{ origin: { x: number; y: number }; rect: Rect; additive: boolean } | null>(null);
  const panRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const spaceRef = useRef(false);
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

    /* ---- selection on empty space, marquee, panning (§10, §11) ---------- */

    stage.on('mousedown touchstart', (e) => {
      setMenu(null);
      const state = useStore.getState();
      if (state.tool !== 'select') return;

      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const mouse = e.evt as MouseEvent;

      // Space+drag, or the middle button, pans whatever is underneath (§11).
      if (spaceRef.current || mouse.button === 1) {
        panRef.current = {
          x: pointer.x,
          y: pointer.y,
          offsetX: state.view.offsetX,
          offsetY: state.view.offsetY,
        };
        return;
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

    stage.on('mousemove touchmove', () => {
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const state = useStore.getState();

      if (panRef.current) {
        const pan = panRef.current;
        state.setView({
          offsetX: pan.offsetX + (pointer.x - pan.x),
          offsetY: pan.offsetY + (pointer.y - pan.y),
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

    const finishPointer = () => {
      panRef.current = null;
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

    /* ---- context menu (§11) --------------------------------------------- */

    stage.on('contextmenu', (e) => {
      e.evt.preventDefault();
      const state = useStore.getState();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const world = screenToWorld(state.view, pointer.x, pointer.y);
      const hit = objectsAt(state.doc, world.x, world.y)[0];

      if (hit && !state.selection.includes(hit.id)) state.setSelection([hit.id]);
      setMenu({
        x: pointer.x,
        y: pointer.y,
        world,
        onObject: Boolean(hit) || useStore.getState().selection.length > 0,
      });
    });

    /* ---- zoom at cursor (§11) ------------------------------------------- */

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;

      const state = useStore.getState();
      const before = screenToWorld(state.view, px, py);
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const scale = Math.min(Math.max(state.view.scale * factor, 0.05), 16);

      // Keep the world point under the cursor fixed while zooming.
      state.setView({ scale, offsetX: px - before.x * scale, offsetY: py - before.y * scale });
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    const onSpace = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      spaceRef.current = event.type === 'keydown';
      container.style.cursor = spaceRef.current ? 'grab' : '';
      if (event.type === 'keydown') event.preventDefault();
    };
    window.addEventListener('keydown', onSpace);
    window.addEventListener('keyup', onSpace);

    return () => {
      observer.disconnect();
      container.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onSpace);
      window.removeEventListener('keyup', onSpace);
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
    const startedAt = performance.now();

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const state = useStore.getState();
      const stage = stageRef.current;
      const content = contentRef.current;
      const overlay = overlayRef.current;
      const interaction = interactionRef.current;
      if (!stage || !content || !overlay || !interaction) return;

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
      const interacting = marquee !== null || guides.length > 0;

      // Nothing to redraw if neither the frame nor the document has moved. A
      // static document therefore costs one scene build, not sixty a second.
      if (!missing && !interacting && frame === lastFrame && state.revision === lastRevision) return;
      lastFrame = frame;
      lastRevision = state.revision;

      if (frame !== state.previewFrame) state.setPreviewFrame(frame);

      const { view } = state;
      content.destroyChildren();
      const group = buildScene(state.doc, frame, { clipToCanvas: false });
      group.scale({ x: view.scale, y: view.scale });
      group.position({ x: view.offsetX, y: view.offsetY });
      content.add(group);

      drawOverlay(overlay, { ...state, snapGuides: guides, marquee });
      interaction.sync();

      content.batchDraw();
      overlay.batchDraw();
      interaction.layer.batchDraw();
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
      {menu ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
