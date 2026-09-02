import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { encodeGradient } from './export/gradientProbe';
import { exportDocument } from './export/exportScene';
import { useStore } from './state/store';
import './index.css';

// Dev-only hooks so scripts/*.mjs can drive real work through the real
// transport without simulating clicks. Vite strips these from production
// builds, so they cannot reach a packaged app.
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __mwProbe: encodeGradient,
    __mwStore: useStore,
    __mwExport: exportDocument,
    // Waits for every background decode to finish (§7). Import no longer blocks
    // on the full decode, so a test that inspects the disk cache has to say so.
    __mwIdle: (timeoutMs = 90_000) =>
      new Promise<boolean>((resolve) => {
        const startedAt = Date.now();
        const check = () => {
          if (useStore.getState().imports.length === 0) return resolve(true);
          if (Date.now() - startedAt > timeoutMs) return resolve(false);
          setTimeout(check, 50);
        };
        check();
      }),
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
