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
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
