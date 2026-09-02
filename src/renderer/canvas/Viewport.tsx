import Konva from 'konva';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { buildScene, framesNeededAt } from '../scene/buildScene';
import { planLoop } from '../scene/timing';
import { load, peek } from '../media/bitmapCache';
import { importFiles, pathsFromDataTransfer } from '../media/importMedia';
import { screenToWorld, useStore } from '../state/store';
import { drawOverlay } from './overlay';

/** How far ahead to decode. Roughly half a second at typical output rates. */
const PREFETCH_FRAMES = 12;

/**
 * The canvas viewport (CLAUDE.md §3, §9, §11).
 *
 * Two Konva layers: content, built only by `buildScene`, and an overlay for
 * chrome that must never reach the output — checkerboard, out-of-canvas grey,
 * selection handles, snap guides.
 *
 * One shared requestAnimationFrame loop advances a global output frame index and
 * redraws once (§11). Never one timer per layer.
 */
export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const contentRef = useRef<Konva.Layer | null>(null);
  const overlayRef = useRef<Konva.Layer | null>(null);

  // Create the stage once. React never owns these nodes: Konva does its own
  // rendering, and re-creating the stage per render would thrash the GPU.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const stage = new Konva.Stage({ container, width: 1, height: 1 });
    const content = new Konva.Layer({ listening: false });
    const overlay = new Konva.Layer({ listening: false });
    stage.add(content);
    stage.add(overlay);

    stageRef.current = stage;
    contentRef.current = content;
    overlayRef.current = overlay;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      stage.size({ width: rect.width, height: rect.height });
      useStore.getState().setViewport({ width: rect.width, height: rect.height });
    };
    resize();
    useStore.getState().fitToWindow();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
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
      if (!stage || !content || !overlay) return;

      const plan = planLoop(state.doc);

      // Drive the frame index from wall-clock time rather than incrementing once
      // per rAF: a 120 Hz display must not play a 25 fps loop at five times speed.
      const frame = plan.isStatic
        ? 0
        : Math.floor(((performance.now() - startedAt) / 1000) * plan.fps) % plan.frameCount;

      // buildScene only peeks the bitmap cache: it draws nothing for a frame
      // that is not decoded yet, because it has to stay synchronous for export.
      // The preview is what asks for those frames, and it keeps redrawing while
      // any are outstanding so they appear as soon as they land.
      let missing = false;
      for (const need of framesNeededAt(state.doc, frame)) {
        if (peek(need.cacheKey, need.index)) continue;
        missing = true;
        void load(need.cacheKey, need.index);
      }

      // Decode a little ahead so playback does not stutter on first loop.
      if (!plan.isStatic) {
        for (let ahead = 1; ahead <= PREFETCH_FRAMES; ahead += 1) {
          const future = (frame + ahead) % plan.frameCount;
          for (const need of framesNeededAt(state.doc, future)) {
            if (!peek(need.cacheKey, need.index)) void load(need.cacheKey, need.index);
          }
        }
      }

      // Nothing to redraw if neither the frame nor the document has moved. A
      // static document therefore costs one scene build, not sixty a second.
      if (!missing && frame === lastFrame && state.revision === lastRevision) return;
      lastFrame = frame;
      lastRevision = state.revision;

      if (frame !== state.previewFrame) state.setPreviewFrame(frame);

      const { view } = state;
      content.destroyChildren();
      const group = buildScene(state.doc, frame, { clipToCanvas: false });
      group.scale({ x: view.scale, y: view.scale });
      group.position({ x: view.offsetX, y: view.offsetY });
      content.add(group);

      drawOverlay(overlay, state);

      content.batchDraw();
      overlay.batchDraw();
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
    />
  );
}
