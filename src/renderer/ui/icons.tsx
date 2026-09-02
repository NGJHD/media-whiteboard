import type { ReactNode } from 'react';

/**
 * Tool and action icons (CLAUDE.md §9).
 *
 * Path data is from Lucide v0.545.0 (ISC), inlined rather than pulled from a
 * package or a CDN: §1 forbids runtime prerequisites and the portable zip must
 * not depend on the network. See THIRD-PARTY-NOTICES.md.
 *
 * Every glyph shares the same 24x24 grid and stroke settings, so they line up
 * optically in the square tool buttons without per-icon nudging.
 */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconSelect() {
  return (
    <Glyph>
      <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
    </Glyph>
  );
}

export function IconBrush() {
  return (
    <Glyph>
      <path d="m14.622 17.897-10.68-2.913" />
      <path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z" />
      <path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15" />
    </Glyph>
  );
}

export function IconEraser() {
  return (
    <Glyph>
      <path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21" />
      <path d="m5.082 11.09 8.828 8.828" />
    </Glyph>
  );
}

export function IconText() {
  return (
    <Glyph>
      <path d="M12 4v16" />
      <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
      <path d="M9 20h6" />
    </Glyph>
  );
}

export function IconRect() {
  return (
    <Glyph>
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </Glyph>
  );
}

export function IconEllipse() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="10" />
    </Glyph>
  );
}

export function IconUndo() {
  return (
    <Glyph>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </Glyph>
  );
}

export function IconRedo() {
  return (
    <Glyph>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
    </Glyph>
  );
}

export function IconAddMedia() {
  return (
    <Glyph>
      <path d="M16 5h6" />
      <path d="M19 2v6" />
      <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      <circle cx="9" cy="9" r="2" />
    </Glyph>
  );
}

export function IconInfo() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Glyph>
  );
}
