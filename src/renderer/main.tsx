import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { encodeGradient } from './export/gradientProbe';
import './index.css';

// Dev-only hook so scripts/smoke-export.mjs can drive a real export through the
// real transport without simulating clicks. Vite strips this from production
// builds, so it cannot reach a packaged app.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__mwProbe = encodeGradient;
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
