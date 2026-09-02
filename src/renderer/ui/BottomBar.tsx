import { useEffect, useMemo, useState } from 'react';
import type { OutputFormat, Quality } from '../../shared/ipc';
import { useStore } from '../state/store';
import { autoFps, FPS_OPTIONS, planLoop } from '../scene/timing';
import { estimateBytes } from '../export/exportScene';

/** §12 asks for this warning once, not once per format change. */
let warnedAboutGifAlpha = false;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * §9 bottom bar — one row: the output path on the left, the generation settings
 * and Generate on the right.
 *
 * The path is a normal editable field. Browse is a convenience, not the only
 * way in: typing or pasting a path is often faster than walking a save dialog.
 */
export function BottomBar({ onGenerate }: { onGenerate(): void }) {
  const doc = useStore((s) => s.doc);
  const apply = useStore((s) => s.apply);
  const busy = useStore((s) => s.imports.length > 0);

  const plan = useMemo(() => planLoop(doc), [doc]);
  const auto = useMemo(() => autoFps(doc), [doc]);
  const estimate = useMemo(() => estimateBytes(doc), [doc]);

  // Local text state, so a half-typed path is not a document edit per keystroke.
  const [path, setPath] = useState(doc.outputPath);
  useEffect(() => setPath(doc.outputPath), [doc.outputPath]);

  function commitPath() {
    const next = path.trim();
    if (next === doc.outputPath) return;
    if (next.length === 0) {
      setPath(doc.outputPath);
      return;
    }
    apply('Output path', (draft) => {
      draft.outputPath = next;
    });
  }

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

    // The new extension may collide with a file that is already there; §12's
    // rule is that the suggested path is always free.
    void window.api.uniqueOutputPath(useStore.getState().doc.outputPath).then((unique) => {
      useStore.getState().mutate((draft) => {
        draft.outputPath = unique;
      });
    });

    // §12: warn once that GIF's 1-bit alpha makes soft edges ragged. Only worth
    // saying when there is actually transparency to ruin.
    if (format === 'gif' && doc.background.transparent && !warnedAboutGifAlpha) {
      warnedAboutGifAlpha = true;
      useStore.getState().toast(
        'warn',
        'GIF alpha is 1-bit: soft or anti-aliased transparent edges will look ragged.',
      );
    }
  }

  return (
    <footer className="bottombar">
      <div className="bottombar-row">
        <label className="field grow">
          Output
          <input
            value={path}
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            onBlur={commitPath}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPath();
              if (e.key === 'Escape') setPath(doc.outputPath);
            }}
          />
        </label>
        <button className="ghost" onClick={() => void browse()}>
          Browse
        </button>

        <span className="divider" />

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
            <span>Static — 1 frame</span>
          ) : (
            <span>
              {plan.frameCount} frames · {(plan.frameCount / plan.fps).toFixed(1)}s · ~
              {formatBytes(estimate)}
            </span>
          )}
          {/* §8.1: warn when the LCM exceeded the cap and layers cut mid-cycle. */}
          {plan.capped ? (
            <span className="capped" title="The loop exceeded 30 seconds, so it was shortened to the longest single layer.">
              loop capped
            </span>
          ) : null}
        </div>

        <button
          className="primary"
          onClick={onGenerate}
          disabled={!doc.outputPath || busy}
          title={busy ? 'Waiting for a source to finish decoding' : 'Render and encode the loop'}
        >
          Generate
        </button>
      </div>
    </footer>
  );
}
