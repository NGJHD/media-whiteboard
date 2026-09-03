import { useCallback, useEffect, useState } from 'react';
import { AUTHOR, REPO, REPO_URL } from '../../shared/about';
import type {
  AppInfo,
  CacheInfo,
  FfmpegInfo,
  UpdateAvailable,
  UpdateProgress,
} from '../../shared/ipc';
import { stats as bitmapStats } from '../media/bitmapCache';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * The update section's state machine (UPDATE_BUTTON.md §1). `busy` covers the
 * download and everything after it; the phase inside the progress event is what
 * distinguishes them, and it is also what decides whether Cancel is still
 * honest (§5 — once unpacking starts there is nothing left to abort).
 */
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; latestVersion: string }
  | { kind: 'available'; target: UpdateAvailable }
  | { kind: 'busy'; target: UpdateAvailable; progress: UpdateProgress }
  | { kind: 'error'; message: string };

const PHASE_LABEL: Record<UpdateProgress['phase'], string> = {
  downloading: 'Downloading',
  unpacking: 'Unpacking',
  verifying: 'Verifying',
  applying: 'Restarting to apply the update…',
};

/**
 * About / Settings (CLAUDE.md §7, §15) and the self-update button
 * (UPDATE_BUTTON.md).
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
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });
  const memory = bitmapStats();

  // Nothing may interrupt an update in flight: the download is cancellable from
  // its own button, and after that there is a .cmd script waiting on this
  // process to exit.
  const busy = update.kind === 'busy';
  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo);
    void window.api.getFfmpegInfo().then(setFfmpeg);
    void window.api.getCacheInfo().then(setCache);
  }, []);

  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => e.key === 'Escape' && requestClose();
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [requestClose]);

  useEffect(
    () =>
      window.api.onUpdateProgress((progress) =>
        setUpdate((prev) => (prev.kind === 'busy' ? { ...prev, progress } : prev)),
      ),
    [],
  );

  async function clear() {
    setClearing(true);
    try {
      setCache(await window.api.clearCache());
    } finally {
      setClearing(false);
    }
  }

  async function check() {
    setUpdate({ kind: 'checking' });
    const result = await window.api.checkForUpdate();
    if (result.status === 'available') setUpdate({ kind: 'available', target: result });
    else if (result.status === 'latest')
      setUpdate({ kind: 'latest', latestVersion: result.latestVersion });
    else setUpdate({ kind: 'error', message: result.message });
  }

  async function install(target: UpdateAvailable) {
    setUpdate({
      kind: 'busy',
      target,
      progress: { phase: 'downloading', receivedBytes: 0, totalBytes: target.assetBytes },
    });
    const result = await window.api.installUpdate(target);
    // On success the app is quitting, so leaving the "Restarting…" line up is
    // the truthful thing to show.
    if (result.ok) return;
    if (result.cancelled) setUpdate({ kind: 'available', target });
    else setUpdate({ kind: 'error', message: result.error ?? 'The update failed.' });
  }

  const openRepo = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    void window.api.openRepoLink(url);
  };

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Media Whiteboard</h2>

        <dl className="about">
          <dt>Made by</dt>
          <dd>{AUTHOR}</dd>
          <dt>Repo</dt>
          <dd>
            <a href={REPO_URL} className="about-link" onClick={openRepo(REPO_URL)}>
              github.com/{REPO}
            </a>
          </dd>
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

        <UpdateSection
          state={update}
          currentVersion={info?.appVersion ?? null}
          onCheck={() => void check()}
          onInstall={(target) => void install(target)}
          onCancel={() => window.api.cancelUpdate()}
          onOpen={openRepo}
        />

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
          <button onClick={requestClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Nothing here happens on its own: no check on launch, no nagging. The user
 * presses the button. An app that quietly replaces itself is an app that breaks
 * in the middle of someone's work (UPDATE_BUTTON.md §9).
 */
function UpdateSection({
  state,
  currentVersion,
  onCheck,
  onInstall,
  onCancel,
  onOpen,
}: {
  state: UpdateState;
  currentVersion: string | null;
  onCheck(): void;
  onInstall(target: UpdateAvailable): void;
  onCancel(): void;
  onOpen(url: string): (e: React.MouseEvent) => void;
}) {
  if (state.kind === 'busy') {
    const { phase, receivedBytes, totalBytes } = state.progress;
    const fraction = phase === 'downloading' && totalBytes > 0 ? receivedBytes / totalBytes : 1;

    return (
      <div className="about-update">
        <div>
          <strong>{PHASE_LABEL[phase]}</strong>
          <span className="sub">
            {/* §5: bytes, not just a percentage — a bare spinner does not tell
                anyone whether it is stuck. */}
            {phase === 'downloading'
              ? `${formatBytes(receivedBytes)} of ${formatBytes(totalBytes)}`
              : `Version ${state.target.latestVersion}`}
          </span>
          <div className="bar">
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        </div>
        {/* §5: hide Cancel once unpacking starts — there is nothing left to
            abort, so a button there would be lying. */}
        {phase === 'downloading' ? <button onClick={onCancel}>Cancel</button> : null}
      </div>
    );
  }

  if (state.kind === 'available') {
    return (
      <div className="about-update">
        <div>
          <strong>Version {state.target.latestVersion} is available</strong>
          <span className="sub">
            {state.target.assetName} · {formatBytes(state.target.assetBytes)}
            {state.target.releaseUrl ? (
              <>
                {' · '}
                <a
                  href={state.target.releaseUrl}
                  className="about-link"
                  onClick={onOpen(state.target.releaseUrl)}
                >
                  Release notes
                </a>
              </>
            ) : null}
          </span>
        </div>
        <button className="primary" onClick={() => onInstall(state.target)}>
          Update
        </button>
      </div>
    );
  }

  const message =
    state.kind === 'checking'
      ? 'Checking GitHub…'
      : state.kind === 'latest'
        ? `Version ${state.latestVersion} is the latest.`
        : state.kind === 'error'
          ? state.message
          : 'Updates are downloaded from the GitHub releases page. Nothing is checked automatically.';

  return (
    <div className="about-update">
      <div>
        <strong>{currentVersion ? `Version ${currentVersion}` : 'Updates'}</strong>
        <span className={state.kind === 'error' ? 'sub update-error' : 'sub'}>{message}</span>
      </div>
      <button onClick={onCheck} disabled={state.kind === 'checking'}>
        {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
      </button>
    </div>
  );
}
