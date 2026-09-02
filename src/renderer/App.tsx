import { useEffect, useRef, useState } from 'react';
import type { AppInfo, ExportPhase, FfmpegInfo, OutputFormat, Quality } from '../shared/ipc';
import { encodeGradient } from './export/gradientProbe';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; phase: ExportPhase; progress: number }
  | { kind: 'done'; path: string; bytes: number; ms: number }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; detail: string | null };

const PHASE_LABEL: Record<ExportPhase, string> = {
  rendering: 'Rendering frames',
  palette: 'Generating palette',
  encoding: 'Encoding',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [format, setFormat] = useState<OutputFormat>('webp');
  const [quality, setQuality] = useState<Quality>('high');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo);
    void window.api.getFfmpegInfo().then(setFfmpeg);
  }, []);

  async function run() {
    if (!info) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: 'running', phase: 'rendering', progress: 0 });

    const outputPath = `${info.appFolder}\\gradient-probe.${format}`;

    try {
      const result = await encodeGradient({
        width: 480,
        height: 270,
        fps: 25,
        frameCount: 50, // exactly 2 s, so the loop closes cleanly
        format,
        quality,
        outputPath,
        signal: controller.signal,
        onProgress: (phase, progress) => setStatus({ kind: 'running', phase, progress }),
      });

      if (result.cancelled) setStatus({ kind: 'cancelled' });
      else setStatus({ kind: 'done', path: result.outputPath, bytes: result.bytes, ms: result.elapsedMs });
    } catch (err) {
      const e = err as Error & { detail?: string | null };
      setStatus({ kind: 'error', message: e.message, detail: e.detail ?? null });
    } finally {
      abortRef.current = null;
    }
  }

  const running = status.kind === 'running';

  return (
    <div className="shell">
      <div className="card">
        <h1>Media Whiteboard</h1>
        <p className="sub">Step 2 — ffmpeg bundled, export pipe proven.</p>

        {info ? (
          <dl>
            <dt>Electron</dt>
            <dd>{info.electron}</dd>
            <dt>App folder</dt>
            <dd>{info.appFolder}</dd>
            <dt>Cache</dt>
            <dd>{info.cacheDir}</dd>
            <dt>ffmpeg</dt>
            <dd>{ffmpeg ? (ffmpeg.ok ? ffmpeg.version : `unavailable — ${ffmpeg.error}`) : '…'}</dd>
          </dl>
        ) : (
          <p className="sub">Reading app info…</p>
        )}

        {info?.usingFallback ? (
          <p className="warn">
            The app folder is not writable, so data and cache are in the temp
            directory instead. {info.fallbackReason}
          </p>
        ) : null}

        <div className="row">
          <label>
            Format
            <select
              value={format}
              disabled={running}
              onChange={(e) => setFormat(e.target.value as OutputFormat)}
            >
              <option value="webp">WebP</option>
              <option value="gif">GIF</option>
            </select>
          </label>
          <label>
            Quality
            <select
              value={quality}
              disabled={running}
              onChange={(e) => setQuality(e.target.value as Quality)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <button onClick={() => void run()} disabled={running || !ffmpeg?.ok}>
            Encode gradient
          </button>
          {running ? (
            <button className="ghost" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          ) : null}
        </div>

        {status.kind === 'running' ? (
          <div className="progress">
            <div className="bar">
              <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
            <p className="sub">
              {PHASE_LABEL[status.phase]} — {Math.round(status.progress * 100)}%
            </p>
          </div>
        ) : null}

        {status.kind === 'done' ? (
          <p className="ok">
            Wrote {formatBytes(status.bytes)} in {(status.ms / 1000).toFixed(1)} s —{' '}
            <button className="link" onClick={() => void window.api.revealFile(status.path)}>
              show in folder
            </button>
          </p>
        ) : null}

        {status.kind === 'cancelled' ? <p className="warn">Cancelled. Partial output deleted.</p> : null}

        {status.kind === 'error' ? (
          <div className="warn">
            <strong>{status.message}</strong>
            {status.detail ? <pre>{status.detail}</pre> : null}
          </div>
        ) : null}

        <p className="step">
          Frames are transferred to the main process over a <b>MessagePort</b>, not
          cloned through <b>invoke</b>, and each frame waits for an ack so ffmpeg
          backpressure reaches the render loop.
        </p>
      </div>
    </div>
  );
}
