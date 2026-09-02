import { useEffect, useState } from 'react';
import type { AppInfo } from '../shared/ipc';

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.api.getAppInfo().then(setInfo);
  }, []);

  return (
    <div className="shell">
      <div className="card">
        <h1>Media Whiteboard</h1>
        <p className="sub">
          Step 1 — Electron + Vite + React shell, portable packaging proven.
        </p>

        {info ? (
          <dl>
            <dt>App version</dt>
            <dd>{info.appVersion}</dd>
            <dt>Electron</dt>
            <dd>{info.electron}</dd>
            <dt>Chromium</dt>
            <dd>{info.chrome}</dd>
            <dt>Node</dt>
            <dd>{info.node}</dd>
            <dt>App folder</dt>
            <dd>{info.appFolder}</dd>
            <dt>User data</dt>
            <dd>{info.userData}</dd>
            <dt>Cache</dt>
            <dd>{info.cacheDir}</dd>
            <dt>Mode</dt>
            <dd>{info.isDev ? 'dev (Vite server)' : 'packaged (file://)'}</dd>
          </dl>
        ) : (
          <p className="sub">Reading app info over the preload bridge…</p>
        )}

        {info?.usingFallback ? (
          <p className="warn">
            The app folder is not writable, so data and cache are in the temp
            directory instead. {info.fallbackReason}
          </p>
        ) : null}

        <p className="step">
          The values above arrived through the typed preload bridge with{' '}
          <b>contextIsolation: true</b> and <b>nodeIntegration: false</b>. User data
          and cache sit inside the app folder — nothing is written to{' '}
          <b>%APPDATA%</b> or the registry.
        </p>
      </div>
    </div>
  );
}
