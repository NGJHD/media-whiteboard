import { useMemo } from 'react';
import type { OutputFormat, Quality } from '../../shared/ipc';
import { useStore } from '../state/store';
import { autoFps, FPS_OPTIONS, planLoop } from '../scene/timing';
import { estimateBytes } from '../export/exportScene';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** §9 bottom bar: output path, format, fps, quality, Generate. */
export function BottomBar({ onGenerate }: { onGenerate(): void }) {
  const doc = useStore((s) => s.doc);
  const apply = useStore((s) => s.apply);

  const plan = useMemo(() => planLoop(doc), [doc]);
  const auto = useMemo(() => autoFps(doc), [doc]);
  const estimate = useMemo(() => estimateBytes(doc), [doc]);

  async function browse() {
    const chosen = await window.api.chooseOutputPath(doc.outputPath, doc.format);
    if (!chosen) return;
    apply('Output path', (draft) => {
      draft.outputPath = chosen;
    });
  }

  /** Keeps the extension consistent with the chosen format. */
  function setFormat(format: OutputFormat) {
    apply('Format', (draft) => {
      draft.format = format;
      draft.outputPath = draft.outputPath.replace(/\.(webp|gif)$/i, `.${format}`);
    });
  }

  return (
    <footer className="bottombar">
      <div className="bottombar-row">
        <label className="field grow">
          Output
          <input value={doc.outputPath} readOnly />
        </label>
        <button className="ghost" onClick={() => void browse()}>
          Browse
        </button>
      </div>

      <div className="bottombar-row">
        <label className="field">
          Format
          <select value={doc.format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
            <option value="webp">WebP</option>
            <option value="gif">GIF</option>
          </select>
        </label>

        <label className="field">
          FPS
          <select
            value={doc.outputFps === 'auto' ? 'auto' : String(doc.outputFps)}
            onChange={(e) => {
              const value = e.target.value;
              // §8.0: a manual selection is sticky; only re-selecting Auto
              // re-enables detection.
              apply('Frame rate', (draft) => {
                draft.outputFps = value === 'auto' ? 'auto' : Number(value);
              });
            }}
          >
            {/* §8.0: the dropdown shows the resolved value, e.g. Auto (24). */}
            <option value="auto">Auto ({auto === null ? '—' : auto})</option>
            {FPS_OPTIONS.map((fps) => (
              <option key={fps} value={fps}>
                {fps}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          Quality
          <select
            value={doc.quality}
            onChange={(e) => {
              const quality = e.target.value as Quality;
              apply('Quality', (draft) => {
                draft.quality = quality;
              });
            }}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>

        <div className="estimate">
          {plan.isStatic ? (
            <span>Static output — 1 frame</span>
          ) : (
            <span>
              {plan.frameCount} frames · {(plan.frameCount / plan.fps).toFixed(1)}s loop · ~
              {formatBytes(estimate)}
            </span>
          )}
          {/* §8.1: warn when the LCM exceeded the cap and layers cut mid-cycle. */}
          {plan.capped ? (
            <span className="capped" title="The loop exceeded 30 seconds, so it was shortened to the longest single layer.">
              loop capped — some layers cut mid-cycle
            </span>
          ) : null}
        </div>

        <button className="primary" onClick={onGenerate} disabled={!doc.outputPath}>
          Generate
        </button>
      </div>
    </footer>
  );
}
