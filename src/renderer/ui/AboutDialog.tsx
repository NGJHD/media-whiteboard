import { useEffect, useState } from 'react';
import type { AppInfo, CacheInfo, FfmpegInfo } from '../../shared/ipc';
import { stats as bitmapStats } from '../media/bitmapCache';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * About / Settings (CLAUDE.md §7, §15).
 *
 * Carries the "Clear cache" button showing the current size that §7 asks for,
 * and is where the cache-directory fallback is disclosed when the app folder
 * turned out not to be writable.
 */
export function AboutDialog({ onClose }: { onClose(): void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [clearing, setClearing] = useState(false);
  const memory = bitmapStats();

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo);
    void window.api.getFfmpegInfo().then(setFfmpeg);
    void window.api.getCacheInfo().then(setCache);
  }, []);

  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [onClose]);

  async function clear() {
    setClearing(true);
    try {
      setCache(await window.api.clearCache());
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Media Whiteboard</h2>

        <dl className="about">
          <dt>Version</dt>
          <dd>{info?.appVersion ?? '…'}</dd>
          <dt>Electron</dt>
          <dd>{info ? `${info.electron} · Chromium ${info.chrome} · Node ${info.node}` : '…'}</dd>
          <dt>ffmpeg</dt>
          <dd>{ffmpeg ? (ffmpeg.ok ? ffmpeg.version : `unavailable — ${ffmpeg.error}`) : '…'}</dd>
          <dt>App folder</dt>
          <dd>{info?.appFolder ?? '…'}</dd>
          <dt>Cache folder</dt>
          <dd>{cache?.dir ?? info?.cacheDir ?? '…'}</dd>
        </dl>

        {/* §7: note the fallback in the About dialog when it is in use. */}
        {info?.usingFallback ? (
          <p className="warn">
            The app folder is not writable, so the cache and settings are in the
            system temp directory instead. {info.fallbackReason}
          </p>
        ) : null}

        <div className="about-cache">
          <div>
            <strong>
              {cache ? `${formatBytes(cache.bytes)} in ${cache.entries} entries` : 'Measuring…'}
            </strong>
            <span className="sub">
              {cache ? `Evicted down to ${formatBytes(cache.limitBytes)} on startup.` : ''} Decoded
              frames in memory: {formatBytes(memory.bytes)} of {formatBytes(memory.budget)}.
            </span>
          </div>
          <button onClick={() => void clear()} disabled={clearing || !cache || cache.entries === 0}>
            {clearing ? 'Clearing…' : 'Clear cache'}
          </button>
        </div>

        <p className="sub">
          Bundled ffmpeg is LGPL v3. See THIRD-PARTY-NOTICES.md beside the
          executable for the licence and the corresponding source.
        </p>

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
