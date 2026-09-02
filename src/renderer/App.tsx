import { useEffect, useRef, useState } from 'react';
import { Viewport } from './canvas/Viewport';
import { exportDocument } from './export/exportScene';
import { enumerateFonts } from './state/fonts';
import { installShortcuts } from './state/keyboard';
import { useStore } from './state/store';
import { planLoop } from './scene/timing';
import { AboutDialog } from './ui/AboutDialog';
import { BottomBar } from './ui/BottomBar';
import { ExportModal, type ExportState } from './ui/ExportModal';
import { TopBar } from './ui/TopBar';
import { Toasts } from './ui/Toasts';

export function App() {
  const toast = useStore((s) => s.toast);
  const setFonts = useStore((s) => s.setFonts);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Seed the output path, and enumerate fonts (§10).
  useEffect(() => {
    void (async () => {
      const [info, settings] = await Promise.all([
        window.api.getAppInfo(),
        window.api.getSettings(),
      ]);

      if (!useStore.getState().doc.outputPath) {
        // Feedback items 19 and 22: start in the folder used last, on a file
        // name that does not exist yet. Seeded with `mutate` — the app
        // discovering where to write is not an edit the user can undo.
        const folder = settings.lastOutputDir ?? info.appFolder;
        const unique = await window.api.uniqueOutputPath(`${folder}\\output.webp`);
        useStore.getState().mutate((draft) => {
          draft.outputPath = unique;
        });
      }

      if (info.usingFallback && info.fallbackReason) {
        // §7/§14: the cache fell back to temp; say so once.
        toast('warn', 'Using the temp folder for cache and settings.', info.fallbackReason);
      }
    })();

    void enumerateFonts().then(setFonts);
  }, [setFonts, toast]);

  useEffect(() => installShortcuts(), []);

  /**
   * §7 phase two. The object is already on the canvas by the time any of this
   * arrives; all that is left is to move the progress bar, correct the frame
   * count once ffmpeg has told us the real one, and drop the layer if the
   * decode turned out to be impossible.
   */
  useEffect(
    () =>
      window.api.onMediaProgress((progress) => {
        const store = useStore.getState();

        if (!progress.done) {
          store.updateImport(progress.cacheKey, progress.readyFrames, progress.totalFrames);
          return;
        }

        store.endImport(progress.cacheKey);

        if (progress.error) {
          // §14: a toast and a no-op. The half-decoded layer goes with it —
          // leaving a frozen first frame behind would look like a success.
          store.toast('error', progress.error);
          store.apply('Remove undecodable media', (draft) => {
            draft.objects = draft.objects.filter(
              (o) => o.kind !== 'media' || o.cacheKey !== progress.cacheKey,
            );
          });
          return;
        }

        const meta = progress.meta;
        if (!meta) return;

        // The probe's frame count is an estimate; ffmpeg's is the truth, and §8
        // computes the whole loop from it.
        store.mutate((draft) => {
          for (const obj of draft.objects) {
            if (obj.kind !== 'media' || obj.cacheKey !== meta.cacheKey) continue;
            obj.frameCount = meta.frameCount;
            obj.frameDurationsMs = meta.frameDurationsMs;
          }
        });
      }),
    [],
  );

  /**
   * §7: a background decode exists to feed a layer. Once that layer is gone —
   * deleted, undone away, replaced by a project load — the rest of the decode is
   * minutes of CPU and up to a gigabyte of disk spent on frames nothing will ask
   * for. Derived from the document rather than hooked into each delete path, for
   * the same reason the fit is (§4): there is more than one way to remove an
   * object, and the list of them is wrong the moment someone adds another.
   */
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.doc.objects === previous.doc.objects && state.imports === previous.imports) {
          return;
        }
        if (state.imports.length === 0) return;

        const live = new Set(
          state.doc.objects.filter((o) => o.kind === 'media').map((o) => o.cacheKey),
        );
        for (const job of state.imports) {
          if (live.has(job.cacheKey)) continue;
          window.api.cancelImport(job.cacheKey);
          useStore.getState().endImport(job.cacheKey);
        }
      }),
    [],
  );

  async function generate() {
    const doc = useStore.getState().doc;
    const plan = planLoop(doc);

    // §12: prompt before overwriting an existing file.
    if (!(await window.api.confirmOverwrite(doc.outputPath))) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setExportState({
      phase: 'rendering',
      progress: 0,
      frameCount: plan.isStatic ? 1 : plan.frameCount,
    });

    try {
      const result = await exportDocument({
        doc,
        signal: controller.signal,
        onProgress: (phase, progress) =>
          setExportState((prev) => (prev ? { ...prev, phase, progress } : prev)),
      });

      if (result.cancelled) {
        toast('info', 'Export cancelled. The partial file was deleted.');
      } else {
        toast('info', `Wrote ${(result.bytes / 1024 / 1024).toFixed(2)} MB to ${result.outputPath}`);
        void window.api.revealFile(result.outputPath);

        // Feedback items 19 and 22: remember the folder, and move the field on
        // to the next free name so Generate can be pressed again straight away.
        const folder = result.outputPath.replace(/[\\/][^\\/]*$/, '');
        void window.api.setSettings({ lastOutputDir: folder });
        const next = await window.api.uniqueOutputPath(result.outputPath);
        useStore.getState().mutate((draft) => {
          draft.outputPath = next;
        });
      }
    } catch (err) {
      const e = err as Error & { detail?: string | null };
      // §14: ffmpeg failures surface the last stderr lines in an expandable detail.
      toast('error', e.message, e.detail ?? undefined);
    } finally {
      setExportState(null);
      abortRef.current = null;
    }
  }

  return (
    <div className="app">
      <TopBar onAbout={() => setAboutOpen(true)} />
      <Viewport />
      <BottomBar onGenerate={() => void generate()} />
      <Toasts />
      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
      {exportState ? (
        <ExportModal state={exportState} onCancel={() => abortRef.current?.abort()} />
      ) : null}
    </div>
  );
}
