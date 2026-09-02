import { useEffect, useRef, useState } from 'react';
import { Viewport } from './canvas/Viewport';
import { exportDocument } from './export/exportScene';
import { enumerateFonts } from './state/fonts';
import { installShortcuts } from './state/keyboard';
import { useStore } from './state/store';
import { planLoop } from './scene/timing';
import { BottomBar } from './ui/BottomBar';
import { ExportModal, type ExportState } from './ui/ExportModal';
import { TopBar } from './ui/TopBar';
import { Toasts } from './ui/Toasts';

export function App() {
  const apply = useStore((s) => s.apply);
  const toast = useStore((s) => s.toast);
  const setFonts = useStore((s) => s.setFonts);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Seed the default output path from the app folder, and enumerate fonts (§10).
  useEffect(() => {
    void window.api.getAppInfo().then((info) => {
      if (useStore.getState().doc.outputPath) return;
      apply('Output path', (draft) => {
        draft.outputPath = `${info.appFolder}\\output.webp`;
      });
      if (info.usingFallback && info.fallbackReason) {
        // §7/§14: the cache fell back to temp; say so once.
        toast('warn', 'Using the temp folder for cache and settings.', info.fallbackReason);
      }
    });

    void enumerateFonts().then(setFonts);
  }, [apply, setFonts, toast]);

  useEffect(() => installShortcuts(), []);

  async function generate() {
    const doc = useStore.getState().doc;
    const plan = planLoop(doc);

    // §12: prompt before overwriting an existing file.
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
      <TopBar />
      <Viewport />
      <BottomBar onGenerate={() => void generate()} />
      <Toasts />
      {exportState ? (
        <ExportModal state={exportState} onCancel={() => abortRef.current?.abort()} />
      ) : null}
    </div>
  );
}
