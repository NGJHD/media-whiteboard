import { useEffect, useMemo, useState } from 'react';
import type { OutputFormat, Quality } from '../../shared/ipc';
import { useStore } from '../state/store';
import { autoFps, FPS_OPTIONS, planLoop } from '../scene/timing';
import { estimateBytes } from '../export/exportScene';
import { FORMATS, formatSpec, isFormatAvailable, withExtension } from '../../shared/formats';
import { IconInfo } from './icons';

/** §12 asks for this warning once, not once per format change. */
let warnedAboutGifAlpha = false;
/** Spec §4: the same courtesy for MP4, which has no alpha at all. */
let warnedAboutMp4Alpha = false;

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

  // §6: unavailable formats are shown disabled, not hidden — a greyed option
  // with a reason is easier to understand than one that vanishes.
  const unavailable = useMemo(
    () => FORMATS.filter((f) => !isFormatAvailable(f.id, plan.isStatic)),
    [plan.isStatic],
  );

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
      draft.outputPath = withExtension(draft.outputPath, format);
    });

    // The new extension may collide with a file that is already there; §12's
    // rule is that the suggested path is always free. The document can move
    // on during the IPC round trip — a second format change, or the user
    // typing in the path field — so only write back if the path we asked
    // about is still the one on screen.
    const asked = useStore.getState().doc.outputPath;
    void window.api.uniqueOutputPath(asked).then((unique) => {
      if (useStore.getState().doc.outputPath !== asked) return;
      useStore.getState().mutate((draft) => {
        draft.outputPath = unique;
      });
    });

    if (!doc.background.transparent) return;

    // §12: warn once that GIF's 1-bit alpha makes soft edges ragged, and once
    // that MP4 has no alpha at all. Only worth saying when there is actually
    // transparency at stake.
    if (format === 'gif' && !warnedAboutGifAlpha) {
      warnedAboutGifAlpha = true;
      useStore.getState().toast(
        'warn',
        'GIF alpha is 1-bit: soft or anti-aliased transparent edges will look ragged.',
      );
    }
    if (format === 'mp4' && !warnedAboutMp4Alpha) {
      warnedAboutMp4Alpha = true;
      useStore.getState().toast(
        'warn',
        'MP4 carries no transparency: the background will be flattened to black.',
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
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id} disabled={!isFormatAvailable(f.id, plan.isStatic)}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {unavailable.length > 0 ? (
          <span
            className="field-hint"
            role="img"
            aria-label={`Some formats are unavailable: ${unavailable.map((f) => f.requirement).join(' ')}`}
            title={unavailable.map((f) => f.requirement).join('\n')}
          >
            <IconInfo />
          </span>
        ) : null}

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

        <label className={`field${formatSpec(doc.format).supportsQuality ? '' : ' disabled'}`}>
          Quality
          <select
            value={doc.quality}
            // Spec §7: PNG is lossless, so the control is disabled rather than
            // left to look as though it does something.
            disabled={!formatSpec(doc.format).supportsQuality}
            title={
              formatSpec(doc.format).supportsQuality
                ? undefined
                : `${formatSpec(doc.format).label} is lossless — there is nothing to trade.`
            }
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
